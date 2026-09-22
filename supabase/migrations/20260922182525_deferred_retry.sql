-- deferred_retry
-- A scheduled run that fails on a recognised retrieval error gets one retry
-- 45 minutes later, outside the morning burst, before the failure counts
-- toward the three-strike pause. The retry is an ordinary queued run with
-- source 'deferred_retry' and metadata.deferred_retry_of; the queue's
-- scheduled_for already orders claims, so no new queue is needed.
-- Plan U2: docs/plans/2026-09-22-1620-feat-crawler-scheduling-resilience-plan.md

ALTER TABLE public.scout_dispatch_queue
  DROP CONSTRAINT IF EXISTS scout_dispatch_queue_source_check;
ALTER TABLE public.scout_dispatch_queue
  ADD CONSTRAINT scout_dispatch_queue_source_check
  CHECK (source IN ('scheduled', 'manual', 'deferred_retry'));

-- One retry per original run; the executor asks by original run id.
CREATE INDEX IF NOT EXISTS scout_runs_deferred_retry_of
  ON public.scout_runs ((metadata->>'deferred_retry_of'))
  WHERE metadata ? 'deferred_retry_of';

DROP FUNCTION public.enqueue_scout_dispatch(uuid, uuid, text, int, text);
CREATE FUNCTION public.enqueue_scout_dispatch(
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
  IF v_scout.type NOT IN ('web', 'beat', 'civic') THEN
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

REVOKE ALL ON FUNCTION public.enqueue_scout_dispatch(uuid, uuid, text, int, text, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_scout_dispatch(uuid, uuid, text, int, text, timestamptz, uuid)
  TO service_role;
