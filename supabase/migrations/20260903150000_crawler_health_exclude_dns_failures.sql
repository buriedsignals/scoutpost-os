-- Crawler workflow health: a host DNS cannot resolve is a caller-side URL
-- mistake (most often the docs placeholder your_council_domain.gov pasted
-- verbatim), not a crawler failure. It is recorded terminal on the first
-- attempt by scrape-service and must not open an operator incident.
--
-- Companion change: scrape-service classify_failure() now returns
-- error_class='terminal' for UnresolvableHostError instead of 'retryable',
-- so these no longer burn all three attempts before terminating.

BEGIN;


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
            AND error_message = 'anti-bot fallback delegated to scrape caller'
          )
          AND NOT (
            error_class = 'terminal'
            AND error_message LIKE 'download failed: cannot resolve %'
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
