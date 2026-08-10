-- A parked Page Workflow remains active while its crawler jobs run. Migration
-- 00114 introduced the waiting dispatch state; include it in the older generic
-- stale-run guards so those reconcilers cannot terminate resumable work.

CREATE OR REPLACE FUNCTION public.cleanup_stale_scout_runs(
  p_max_age interval DEFAULT interval '30 minutes'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  UPDATE public.scout_runs r
     SET status = 'error',
         error_message = COALESCE(
           r.error_message,
           'run did not reach a terminal state within the expected execution window'
         ),
         completed_at = now()
   WHERE r.status = 'running'
     AND r.started_at < now() - p_max_age
     AND NOT EXISTS (
       SELECT 1
         FROM public.scout_dispatch_queue q
        WHERE q.scout_run_id = r.id
          AND q.status IN ('queued', 'leased', 'waiting')
     );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_stale_scout_runs(
  p_running_grace interval DEFAULT interval '45 minutes'
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int := 0;
BEGIN
  WITH updated AS (
    UPDATE public.scout_runs r
       SET status = 'error',
           stage = COALESCE(r.stage, 'finalize'),
           error_class = 'timeout',
           error_message = 'run exceeded stale running grace and was reconciled',
           notification_status = COALESCE(r.notification_status, 'not_applicable'),
           notification_reason = COALESCE(r.notification_reason, 'stale_running_reconciled'),
           completed_at = now()
     WHERE r.status = 'running'
       AND r.started_at < now() - p_running_grace
       AND NOT EXISTS (
         SELECT 1
           FROM public.scout_dispatch_queue q
          WHERE q.scout_run_id = r.id
            AND q.status IN ('queued', 'leased', 'waiting')
       )
     RETURNING r.id, r.scout_id, r.user_id, r.stage
  ), inserted_events AS (
    INSERT INTO public.scout_run_events (
      scout_run_id, scout_id, user_id, stage, status, error_class,
      notification_status, message, metadata
    )
    SELECT
      id, scout_id, user_id, stage, 'error', 'timeout', 'not_applicable',
      'run exceeded stale running grace and was reconciled',
      jsonb_build_object('running_grace', p_running_grace::text)
    FROM updated
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM inserted_events;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_stale_scout_runs(interval)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_stale_scout_runs(interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_scout_runs(interval)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_scout_runs(interval)
  TO service_role;
