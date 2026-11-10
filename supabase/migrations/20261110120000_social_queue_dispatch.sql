-- Queue-backed Social Scouts (A2-A4 of docs/plans/2026-11-10-social-run-path-treg-plan.md).
-- 1. The dispatch queue accepts social runs.
-- 2. enqueue_scout_dispatch accepts social scouts (body otherwise identical to
--    20260922182525).
-- 3. reconcile_waiting_scout_dispatches closes social runs whose worker died
--    and refunds the charge once (body otherwise identical to 20261029100000).
-- Social stays on the direct path until execute-scout is told to queue it
-- (SCOUT_DISPATCH_QUEUE_TYPES must list social explicitly).

ALTER TABLE public.scout_dispatch_queue
  DROP CONSTRAINT IF EXISTS scout_dispatch_queue_scout_type_check;
ALTER TABLE public.scout_dispatch_queue
  ADD CONSTRAINT scout_dispatch_queue_scout_type_check
  CHECK (scout_type IN ('web', 'beat', 'civic', 'social'));

CREATE OR REPLACE FUNCTION public.enqueue_scout_dispatch(
  p_scout_id uuid,
  p_run_id uuid DEFAULT NULL,
  p_source text DEFAULT 'scheduled',
  p_priority int DEFAULT 0,
  p_crawler_backend text DEFAULT 'service',
  p_scheduled_for timestamptz DEFAULT now(),
  p_retry_of uuid DEFAULT NULL
)
RETURNS TABLE (run_id uuid, enqueued boolean, crawler_backend text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_scout public.scouts%ROWTYPE;
  v_existing_run_id uuid;
  v_run_id uuid := p_run_id;
  v_source text := lower(COALESCE(p_source, 'scheduled'));
  v_backend text := lower(COALESCE(p_crawler_backend, 'service'));
  v_original public.scout_runs%ROWTYPE;
  v_existing_retry uuid;
  v_metadata jsonb;
BEGIN
  IF v_source NOT IN ('scheduled', 'manual', 'deferred_retry') THEN
    RAISE EXCEPTION 'invalid dispatch source: %', p_source;
  END IF;
  -- A deferred retry is a fresh run that stands in for one failed scheduled
  -- run. It is created here, never re-attached to a caller-supplied run, and
  -- at most one exists per original run.
  IF v_source = 'deferred_retry' THEN
    IF p_run_id IS NOT NULL OR p_retry_of IS NULL THEN
      RAISE EXCEPTION 'deferred retry needs the failed run and creates its own';
    END IF;
    SELECT * INTO v_original FROM public.scout_runs
     WHERE id = p_retry_of AND scout_id = p_scout_id;
    IF NOT FOUND OR v_original.status <> 'error'
       OR COALESCE(v_original.metadata->>'dispatch_source', '') <> 'scheduled' THEN
      RAISE EXCEPTION 'deferred retry requires a failed scheduled run';
    END IF;
    SELECT r.id INTO v_existing_retry FROM public.scout_runs r
     WHERE r.metadata->>'deferred_retry_of' = p_retry_of::text
     ORDER BY r.started_at LIMIT 1;
    IF v_existing_retry IS NOT NULL THEN
      RETURN QUERY SELECT v_existing_retry, false, r.crawler_backend
        FROM public.scout_runs r WHERE r.id = v_existing_retry;
      RETURN;
    END IF;
  ELSIF p_retry_of IS NOT NULL THEN
    RAISE EXCEPTION 'p_retry_of is only valid for deferred retries';
  END IF;
  v_metadata := jsonb_build_object('dispatch_source', v_source)
    || CASE WHEN p_retry_of IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('deferred_retry_of', p_retry_of) END;
  IF v_backend NOT IN ('service', 'workflow') THEN
    RAISE EXCEPTION 'invalid crawler backend';
  END IF;

  SELECT * INTO v_scout FROM public.scouts
   WHERE id = p_scout_id AND is_active = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'scout is paused or not found'; END IF;
  IF v_scout.type NOT IN ('web', 'beat', 'civic', 'social') THEN
    RAISE EXCEPTION 'scout type % is not queue-backed', v_scout.type;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_scout_id::text, 0));
  SELECT q.scout_run_id INTO v_existing_run_id
    FROM public.scout_dispatch_queue q
   WHERE q.scout_id = p_scout_id
     AND q.status IN ('queued', 'leased', 'waiting')
   ORDER BY q.created_at LIMIT 1;

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
      scout_id, user_id, status, stage, started_at, metadata, crawler_backend,
      workflow_stage
    ) VALUES (
      p_scout_id, v_scout.user_id, 'running', 'queued', now(),
      v_metadata, v_backend,
      CASE WHEN v_backend = 'workflow' THEN 'needs_root' END
    ) RETURNING id INTO v_run_id;
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
           workflow_stage = CASE
             WHEN v_backend = 'workflow' THEN COALESCE(workflow_stage, 'needs_root')
             ELSE workflow_stage
           END,
           metadata = COALESCE(metadata, '{}'::jsonb) || v_metadata
     WHERE id = v_run_id;
  END IF;

  INSERT INTO public.scout_dispatch_queue (
    scout_run_id, scout_id, user_id, scout_type, source, priority, scheduled_for
  ) VALUES (
    v_run_id, p_scout_id, v_scout.user_id, v_scout.type, v_source,
    LEAST(1000, GREATEST(-1000, COALESCE(p_priority, 0))),
    GREATEST(now(), COALESCE(p_scheduled_for, now()))
  );
  RETURN QUERY SELECT v_run_id, true, v_backend;
END;
$$;

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
  v_operation text;
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

  -- Social runs finish under EdgeRuntime.waitUntil after answering the
  -- dispatcher 202. If the runtime kills the worker (400 s hosted), nothing
  -- marks the run terminal; close it, and refund the charge the worker took
  -- (key social:<run>:charge) unless a refund already landed. The window runs
  -- from the park time (q.updated_at), not from run creation, so a run that
  -- waited in the queue is not closed while its worker is still alive.
  FOR v_run IN
    SELECT r.id, r.user_id, r.scout_id
      FROM public.scout_runs r
      JOIN public.scouts s ON s.id = r.scout_id AND s.type = 'social'
      JOIN public.scout_dispatch_queue q ON q.scout_run_id = r.id
     WHERE r.status = 'running' AND q.status = 'waiting'
       AND q.updated_at <= now() - interval '30 minutes'
     FOR UPDATE OF r SKIP LOCKED
  LOOP
    UPDATE public.scout_runs
       SET status = 'error', stage = 'finalize', completed_at = now(),
           error_class = 'platform',
           error_message = 'Social worker stopped before finishing the run'
     WHERE id = v_run.id AND status = 'running';
    IF FOUND THEN
      SELECT cost, operation INTO v_cost, v_operation FROM public.usage_records
       WHERE idempotency_key = 'social:' || v_run.id::text || ':charge';
      IF FOUND AND NOT EXISTS (
        SELECT 1 FROM public.usage_records
         WHERE idempotency_key = 'social:' || v_run.id::text || ':refund'
      ) THEN
        PERFORM public.refund_credits_once(
          'social:' || v_run.id::text || ':refund', v_run.user_id, v_cost,
          v_run.scout_id, 'social', v_operation
        );
      END IF;
      UPDATE public.scout_dispatch_queue
         SET status = 'failed', completed_at = COALESCE(completed_at, now()),
             updated_at = now()
       WHERE scout_run_id = v_run.id AND status = 'waiting';
      v_total := v_total + 1;
    END IF;
  END LOOP;

  RETURN v_total;
END;
$function$;
