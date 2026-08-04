-- Pin every Scout run to one crawler backend before queue admission. All
-- defaults and existing rows remain on the current service through Gate B.

ALTER TABLE public.scout_runs
  ADD COLUMN crawler_backend text NOT NULL DEFAULT 'service'
  CHECK (crawler_backend IN ('service', 'workflow'));

DROP FUNCTION public.enqueue_scout_dispatch(uuid, uuid, text, int);

CREATE FUNCTION public.enqueue_scout_dispatch(
  p_scout_id uuid,
  p_run_id uuid DEFAULT NULL,
  p_source text DEFAULT 'scheduled',
  p_priority int DEFAULT 0,
  p_crawler_backend text DEFAULT 'service'
)
RETURNS TABLE (run_id uuid, enqueued boolean, crawler_backend text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_scout public.scouts%ROWTYPE;
  v_existing_run_id uuid;
  v_run_id uuid := p_run_id;
  v_source text := lower(COALESCE(p_source, 'scheduled'));
  v_backend text := lower(COALESCE(p_crawler_backend, 'service'));
BEGIN
  IF v_source NOT IN ('scheduled', 'manual') THEN
    RAISE EXCEPTION 'invalid dispatch source: %', p_source;
  END IF;
  IF v_backend NOT IN ('service', 'workflow') THEN
    RAISE EXCEPTION 'invalid crawler backend';
  END IF;

  SELECT * INTO v_scout
    FROM public.scouts
   WHERE id = p_scout_id
     AND is_active = true;

  IF NOT FOUND THEN RAISE EXCEPTION 'scout is paused or not found'; END IF;
  IF v_scout.type NOT IN ('web', 'beat', 'civic') THEN
    RAISE EXCEPTION 'scout type % is not queue-backed', v_scout.type;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_scout_id::text, 0));

  SELECT q.scout_run_id INTO v_existing_run_id
    FROM public.scout_dispatch_queue q
   WHERE q.scout_id = p_scout_id
     AND q.status IN ('queued', 'leased')
   ORDER BY q.created_at
   LIMIT 1;

  IF v_existing_run_id IS NOT NULL THEN
    IF v_run_id IS NOT NULL AND v_run_id <> v_existing_run_id THEN
      UPDATE public.scout_runs
         SET status = 'skipped', stage = 'finalize',
             error_message = 'a run for this scout is already queued or executing',
             completed_at = now()
       WHERE id = v_run_id AND scout_id = p_scout_id AND status = 'running';
    END IF;
    RETURN QUERY SELECT v_existing_run_id, false, r.crawler_backend
      FROM public.scout_runs r WHERE r.id = v_existing_run_id;
    RETURN;
  END IF;

  IF v_run_id IS NULL THEN
    INSERT INTO public.scout_runs (
      scout_id, user_id, status, stage, started_at, metadata, crawler_backend
    ) VALUES (
      p_scout_id, v_scout.user_id, 'running', 'queued', now(),
      jsonb_build_object('dispatch_source', v_source), v_backend
    )
    RETURNING id INTO v_run_id;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.scout_runs r
       WHERE r.id = v_run_id AND r.scout_id = p_scout_id
         AND r.user_id = v_scout.user_id AND r.status = 'running'
    ) THEN
      RAISE EXCEPTION 'run is missing, terminal, or does not belong to scout';
    END IF;
    UPDATE public.scout_runs
       SET stage = 'queued', crawler_backend = v_backend,
           metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('dispatch_source', v_source)
     WHERE id = v_run_id;
  END IF;

  INSERT INTO public.scout_dispatch_queue (
    scout_run_id, scout_id, user_id, scout_type, source, priority
  ) VALUES (
    v_run_id, p_scout_id, v_scout.user_id, v_scout.type, v_source,
    LEAST(1000, GREATEST(-1000, COALESCE(p_priority, 0)))
  );

  RETURN QUERY SELECT v_run_id, true, v_backend;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_scout_dispatch(uuid, uuid, text, int, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_scout_dispatch(uuid, uuid, text, int, text)
  TO service_role;

CREATE INDEX crawler_batches_active_metrics_idx
  ON public.crawler_batches(render_metrics_checked_at NULLS FIRST)
  WHERE render_task_run_id IS NOT NULL AND render_terminal = false;
CREATE INDEX crawler_batches_completed_idx
  ON public.crawler_batches(completed_at)
  WHERE completed_at IS NOT NULL;
CREATE INDEX crawler_jobs_terminal_cleanup_idx
  ON public.crawler_jobs(completed_at)
  WHERE completed_at IS NOT NULL;

CREATE FUNCTION public.crawler_operations_health()
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

REVOKE ALL ON FUNCTION public.crawler_operations_health()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crawler_operations_health() TO service_role;

CREATE FUNCTION public.crawler_gate_b_preflight()
RETURNS TABLE (
  recurring_cron_exists boolean,
  workflow_scout_runs bigint,
  unpinned_scout_runs bigint,
  observed_active_scouts bigint,
  observed_users bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, cron
AS $$
  SELECT
    EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'crawler-workflow-dispatch'),
    (SELECT count(*) FROM public.scout_runs WHERE crawler_backend = 'workflow'),
    (SELECT count(*) FROM public.scout_runs WHERE crawler_backend IS NULL),
    (SELECT count(*) FROM public.scouts
      WHERE is_active = true AND type IN ('web', 'beat', 'civic')),
    (SELECT count(*) FROM auth.users);
$$;

REVOKE ALL ON FUNCTION public.crawler_gate_b_preflight()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crawler_gate_b_preflight() TO service_role;
