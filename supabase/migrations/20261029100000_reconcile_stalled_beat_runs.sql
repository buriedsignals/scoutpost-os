-- Close Beat runs whose background worker died before marking them terminal.
-- Body otherwise identical to the live definition (20260914131000).
CREATE OR REPLACE FUNCTION public.reconcile_waiting_scout_dispatches()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_changed int;
  v_total int := 0;
  v_run record;
  v_cost int;
BEGIN
  UPDATE public.scout_dispatch_queue q
     SET status = CASE WHEN r.status = 'error' THEN 'failed' ELSE 'done' END,
         completed_at = COALESCE(q.completed_at, now()), updated_at = now()
    FROM public.scout_runs r
   WHERE q.scout_run_id = r.id AND q.status = 'waiting'
     AND r.status IN ('success', 'error', 'skipped');
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  v_total := v_changed;

  FOR v_run IN
    SELECT r.id, r.user_id, r.scout_id
      FROM public.scout_runs r
      JOIN public.scouts s ON s.id = r.scout_id AND s.type = 'web'
      JOIN public.scout_dispatch_queue q ON q.scout_run_id = r.id
     WHERE r.crawler_backend = 'workflow' AND r.status = 'running'
       AND q.status = 'waiting'
       AND r.workflow_progressed_at <= now() - interval '30 minutes'
       AND (r.workflow_lease_expires_at IS NULL OR r.workflow_lease_expires_at <= now())
       AND NOT EXISTS (
         SELECT 1 FROM public.crawler_jobs j
          WHERE j.scout_run_id = r.id
            AND (j.status IN ('queued', 'batched', 'running', 'retryable_failed')
              OR (j.status = 'fallback_required' AND j.lease_expires_at > now()))
       )
     FOR UPDATE OF r SKIP LOCKED
  LOOP
    UPDATE public.scout_runs
       SET status = 'error', stage = 'finalize', completed_at = now(),
           error_message = 'Page workflow continuation stalled',
           workflow_lease_token = NULL, workflow_lease_expires_at = NULL
     WHERE id = v_run.id AND status = 'running';
    IF FOUND THEN
      SELECT cost INTO v_cost FROM public.usage_records
       WHERE idempotency_key = 'page:' || v_run.id::text || ':charge';
      IF FOUND AND NOT EXISTS (
        SELECT 1 FROM public.usage_records
         WHERE idempotency_key = 'page:' || v_run.id::text || ':refund'
      ) THEN
        PERFORM public.refund_credits_once(
          'page:' || v_run.id::text || ':refund', v_run.user_id, v_cost,
          v_run.scout_id, 'web', 'website_extraction'
        );
      END IF;
      UPDATE public.scout_dispatch_queue
         SET status = 'failed', completed_at = COALESCE(completed_at, now()),
             updated_at = now()
       WHERE scout_run_id = v_run.id AND status = 'waiting';
      v_total := v_total + 1;
    END IF;
  END LOOP;
  -- Beat runs finish under EdgeRuntime.waitUntil after answering the
  -- dispatcher 202. If the runtime kills the worker at its wall-clock limit
  -- (400 s hosted), nothing marks the run terminal; close it so the Scout can
  -- run again. Beat credits are charged without an idempotency key, so this
  -- path does not refund.
  WITH stalled AS (
    UPDATE public.scout_runs r
       SET status = 'error', completed_at = now(), error_class = 'platform',
           error_message = 'Beat worker stopped before finishing the run'
      FROM public.scouts s, public.scout_dispatch_queue q
     WHERE s.id = r.scout_id AND s.type = 'beat'
       AND q.scout_run_id = r.id AND q.status = 'waiting'
       AND r.status = 'running'
       AND r.started_at <= now() - interval '30 minutes'
    RETURNING r.id
  )
  UPDATE public.scout_dispatch_queue q
     SET status = 'failed', completed_at = COALESCE(q.completed_at, now()),
         updated_at = now()
    FROM stalled
   WHERE q.scout_run_id = stalled.id AND q.status = 'waiting';
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  v_total := v_total + v_changed;

  RETURN v_total;
END;
$function$;
