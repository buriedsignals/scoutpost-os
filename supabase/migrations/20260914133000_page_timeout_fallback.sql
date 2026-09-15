BEGIN;

ALTER TABLE public.crawler_jobs ADD COLUMN fallback_reason text
  CHECK (fallback_reason IN ('anti_bot', 'timeout_exhausted'));

CREATE FUNCTION public.crawler_fallback_reason(
  p_operation text, p_error_class text, p_attempts int, p_max_attempts int
) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN p_operation <> 'scrape' THEN NULL
    WHEN p_error_class = 'anti_bot' THEN 'anti_bot'
    WHEN p_error_class = 'timeout' AND p_max_attempts > 0 AND p_attempts >= p_max_attempts
      THEN 'timeout_exhausted'
    ELSE NULL
  END;
$$;
REVOKE ALL ON FUNCTION public.crawler_fallback_reason(text, text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crawler_fallback_reason(text, text, int, int) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_crawler_job(
  p_job_id uuid, p_lease_token uuid, p_ok boolean,
  p_manifest jsonb DEFAULT NULL, p_error_class text DEFAULT NULL, p_error text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.crawler_jobs%ROWTYPE;
  v_reason text;
BEGIN
  IF p_ok AND (p_manifest IS NULL OR jsonb_typeof(p_manifest) <> 'object') THEN
    RAISE EXCEPTION 'successful crawler completion requires a manifest';
  END IF;
  IF NOT p_ok AND (p_error_class IS NULL OR p_error_class NOT IN ('anti_bot', 'timeout', 'retryable', 'terminal')) THEN
    RAISE EXCEPTION 'invalid crawler error class';
  END IF;
  SELECT * INTO v_job FROM public.crawler_jobs
   WHERE id = p_job_id AND status = 'running' AND lease_token = p_lease_token FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT p_ok THEN
    v_reason := public.crawler_fallback_reason(v_job.operation, p_error_class, v_job.attempts, v_job.max_attempts);
    IF v_reason = 'timeout_exhausted' AND NOT (
      v_job.request_kind = 'proxy' OR (v_job.request_kind = 'scout_run' AND EXISTS (
        SELECT 1 FROM public.scout_runs r JOIN public.scouts s ON s.id = r.scout_id
        WHERE r.id = v_job.scout_run_id AND r.crawler_backend = 'workflow' AND s.type = 'web'
      ))
    ) THEN v_reason := NULL; END IF;
  END IF;
  UPDATE public.crawler_jobs j SET
    status = CASE WHEN p_ok THEN 'succeeded'
      WHEN v_reason IS NOT NULL THEN 'fallback_required'
      WHEN p_error_class IN ('timeout', 'retryable') AND j.attempts < j.max_attempts THEN 'retryable_failed'
      ELSE 'terminal_failed' END,
    fallback_reason = v_reason,
    batch_id = CASE WHEN NOT p_ok AND p_error_class IN ('timeout', 'retryable') AND j.attempts < j.max_attempts THEN NULL ELSE j.batch_id END,
    available_at = CASE WHEN NOT p_ok AND p_error_class IN ('timeout', 'retryable') AND j.attempts < j.max_attempts
      THEN now() + make_interval(secs => LEAST(300, 5 * power(2, j.attempts)::int)) ELSE j.available_at END,
    result_manifest = CASE WHEN p_ok THEN p_manifest ELSE NULL END,
    error_class = CASE WHEN p_ok THEN NULL ELSE p_error_class END,
    error_message = CASE WHEN p_ok THEN NULL ELSE left(COALESCE(p_error, 'crawl failed'), 1500) END,
    lease_token = NULL, lease_expires_at = NULL, updated_at = now(),
    completed_at = CASE WHEN p_ok OR v_reason IS NOT NULL OR p_error_class = 'terminal'
      OR j.attempts >= j.max_attempts THEN now() ELSE NULL END
  WHERE j.id = p_job_id;
  RETURN true;
END;
$$;

-- Delegated recovery is not a completed retrieval failure; retain all other health exclusions.
CREATE OR REPLACE FUNCTION public.crawler_operations_health()
RETURNS TABLE (
  dispatch_eligible bigint,
  oldest_wait_seconds double precision,
  running bigint,
  expired_running bigint,
  p95_total_seconds double precision,
  fallback_required bigint,
  terminal_failed_recent bigint,
  task_runs_24h bigint,
  task_queue_p95_seconds double precision,
  task_duration_p95_seconds double precision,
  task_memory_peak_bytes bigint,
  task_retry_rate double precision,
  task_outbound_bytes_24h bigint,
  estimated_monthly_compute_dollars double precision
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH jobs AS (
    SELECT
      count(*) FILTER (
        WHERE status IN ('queued', 'retryable_failed') AND available_at <= now()
      ) AS dispatch_eligible,
      extract(epoch FROM now() - min(CASE
        WHEN status IN ('queued', 'retryable_failed') AND available_at <= now()
          THEN available_at
        WHEN status = 'batched' THEN updated_at
      END))::double precision AS oldest_wait_seconds,
      count(*) FILTER (WHERE status = 'running') AS running,
      count(*) FILTER (
        WHERE status = 'running' AND lease_expires_at <= now()
      ) AS expired_running,
      percentile_cont(0.95) WITHIN GROUP (
        ORDER BY extract(epoch FROM completed_at - created_at)
      ) FILTER (
        WHERE completed_at > now() - interval '1 hour'
      )::double precision AS p95_total_seconds,
      count(*) FILTER (WHERE status = 'fallback_required') AS fallback_required,
      count(*) FILTER (
        WHERE status = 'terminal_failed'
          AND completed_at > now() - interval '1 hour'
          AND NOT (
            error_class = 'fallback_terminal'
            AND error_message IN ('anti-bot fallback delegated to scrape caller',
              'timeout-exhausted fallback delegated to scrape caller')
          )
          AND NOT (
            error_class = 'terminal'
            AND error_message LIKE 'download failed: cannot resolve %'
          )
          AND NOT (
            operation = 'parse_pdf'
            AND error_class = 'terminal'
            AND error_message = 'not_a_pdf'
          )
      ) AS terminal_failed_recent
    FROM public.crawler_jobs
  ), tasks AS (
    SELECT
      count(*) AS task_runs_24h,
      percentile_cont(0.95) WITHIN GROUP (
        ORDER BY NULLIF(render_metrics->>'accepted_to_start_seconds', '')::double precision
      ) AS task_queue_p95_seconds,
      percentile_cont(0.95) WITHIN GROUP (
        ORDER BY NULLIF(render_metrics->>'attempt_seconds', '')::double precision
      ) AS task_duration_p95_seconds,
      max(NULLIF(render_metrics->>'memory_peak_bytes', '')::numeric)::bigint
        AS task_memory_peak_bytes,
      avg(CASE
        WHEN COALESCE(NULLIF(render_metrics->>'retry_count', '')::int, 0) > 0
          THEN 1.0 ELSE 0.0
      END)::double precision AS task_retry_rate,
      COALESCE(sum(
        COALESCE(NULLIF(render_metrics->>'outbound_bytes', '')::numeric, 0)
      ), 0)::bigint AS task_outbound_bytes_24h,
      (COALESCE(sum(
        COALESCE(NULLIF(render_metrics->>'attempt_seconds', '')::double precision, 0)
      ), 0) * 30 * 0.20 / 3600)::double precision
        AS estimated_monthly_compute_dollars
    FROM public.crawler_batches
    WHERE render_task_run_id IS NOT NULL
      AND render_metrics_checked_at > now() - interval '24 hours'
  )
  SELECT jobs.*, tasks.* FROM jobs CROSS JOIN tasks;
$$;

COMMIT;
