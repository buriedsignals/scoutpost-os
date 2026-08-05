-- Prepare the Page Scout Render Workflow canary without changing routing.
-- The migration is additive: service-backed runs keep their current behavior.

ALTER TABLE public.scout_runs
  ADD COLUMN workflow_stage text
    CHECK (workflow_stage IS NULL OR workflow_stage IN (
      'needs_root', 'waiting_root', 'waiting_children', 'done'
    )),
  ADD COLUMN workflow_lease_token uuid,
  ADD COLUMN workflow_lease_expires_at timestamptz,
  ADD COLUMN workflow_progressed_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX scout_runs_page_workflow_pending_idx
  ON public.scout_runs(workflow_progressed_at, workflow_lease_expires_at)
  WHERE crawler_backend = 'workflow' AND status = 'running';

ALTER TABLE public.raw_captures ADD COLUMN workflow_effect_key text;
CREATE UNIQUE INDEX raw_captures_workflow_effect_idx
  ON public.raw_captures(workflow_effect_key)
  WHERE workflow_effect_key IS NOT NULL;

ALTER TABLE public.usage_records
  ADD COLUMN idempotency_key text,
  ADD COLUMN balance_after int,
  ADD COLUMN credit_owner text;
CREATE UNIQUE INDEX usage_records_idempotency_idx
  ON public.usage_records(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.scout_dispatch_queue
  DROP CONSTRAINT scout_dispatch_queue_status_check,
  ADD CONSTRAINT scout_dispatch_queue_status_check CHECK (
    status IN ('queued', 'leased', 'waiting', 'done', 'failed', 'canceled')
  );
DROP INDEX public.scout_dispatch_queue_one_active_per_scout;
CREATE UNIQUE INDEX scout_dispatch_queue_one_active_per_scout
  ON public.scout_dispatch_queue(scout_id)
  WHERE status IN ('queued', 'leased', 'waiting');

-- Preserve backend pinning while treating an asynchronous waiting run as the
-- one active run for its Scout.
DROP FUNCTION public.enqueue_scout_dispatch(uuid, uuid, text, int, text);
CREATE FUNCTION public.enqueue_scout_dispatch(
  p_scout_id uuid,
  p_run_id uuid DEFAULT NULL,
  p_source text DEFAULT 'scheduled',
  p_priority int DEFAULT 0,
  p_crawler_backend text DEFAULT 'service'
)
RETURNS TABLE (run_id uuid, enqueued boolean, crawler_backend text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
      jsonb_build_object('dispatch_source', v_source), v_backend,
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

CREATE FUNCTION public.park_scout_dispatch(
  p_queue_id uuid, p_worker_id text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_changed int;
BEGIN
  UPDATE public.scout_dispatch_queue
     SET status = 'waiting', lease_owner = NULL, lease_expires_at = NULL,
         updated_at = now()
   WHERE id = p_queue_id AND status = 'leased' AND lease_owner = p_worker_id;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed = 1;
END;
$$;

CREATE FUNCTION public.finish_waiting_scout_dispatch(p_run_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_changed int;
BEGIN
  UPDATE public.scout_dispatch_queue q
     SET status = CASE WHEN r.status = 'error' THEN 'failed' ELSE 'done' END,
         completed_at = COALESCE(q.completed_at, now()), updated_at = now()
    FROM public.scout_runs r
   WHERE q.scout_run_id = p_run_id AND r.id = p_run_id
     AND q.status = 'waiting' AND r.status IN ('success', 'error', 'skipped');
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed = 1;
END;
$$;

CREATE FUNCTION public.reconcile_waiting_scout_dispatches()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
            AND j.status IN ('queued', 'batched', 'running', 'retryable_failed')
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
  RETURN v_total;
END;
$$;

CREATE FUNCTION public.claim_page_workflow_run(
  p_run_id uuid, p_lease_seconds int DEFAULT 300
) RETURNS TABLE (lease_token uuid, workflow_stage text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_token uuid := gen_random_uuid();
BEGIN
  RETURN QUERY
  UPDATE public.scout_runs r
     SET workflow_stage = COALESCE(r.workflow_stage, 'needs_root'),
         workflow_lease_token = v_token,
         workflow_lease_expires_at = now() + make_interval(
           secs => LEAST(600, GREATEST(60, p_lease_seconds))
         )
   WHERE r.id = p_run_id AND r.crawler_backend = 'workflow'
     AND r.status = 'running'
     AND (r.workflow_lease_expires_at IS NULL OR r.workflow_lease_expires_at <= now())
  RETURNING v_token, r.workflow_stage;
END;
$$;

CREATE FUNCTION public.set_page_workflow_stage(
  p_run_id uuid, p_lease_token uuid, p_stage text, p_release boolean DEFAULT true
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_changed int;
BEGIN
  IF p_stage NOT IN ('needs_root', 'waiting_root', 'waiting_children', 'done') THEN
    RAISE EXCEPTION 'invalid page workflow stage';
  END IF;
  UPDATE public.scout_runs
     SET workflow_stage = p_stage, workflow_progressed_at = now(),
         workflow_lease_token = CASE WHEN p_release THEN NULL ELSE workflow_lease_token END,
         workflow_lease_expires_at = CASE WHEN p_release THEN NULL ELSE workflow_lease_expires_at END
   WHERE id = p_run_id AND status IN ('running', 'success')
     AND crawler_backend = 'workflow' AND workflow_lease_token = p_lease_token;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed = 1;
END;
$$;

CREATE FUNCTION public.pending_page_workflow_resumes(p_limit int DEFAULT 100)
RETURNS TABLE (run_id uuid, scout_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.scout_id
    FROM public.scout_runs r
    JOIN public.scout_dispatch_queue q ON q.scout_run_id = r.id
   WHERE r.crawler_backend = 'workflow' AND r.status = 'running'
     AND q.status = 'waiting'
     AND (r.workflow_lease_expires_at IS NULL OR r.workflow_lease_expires_at <= now())
     AND NOT EXISTS (
       SELECT 1 FROM public.crawler_jobs j
        WHERE j.scout_run_id = r.id
          AND j.status IN ('queued', 'batched', 'running', 'retryable_failed')
     )
   ORDER BY r.workflow_progressed_at, r.id
   LIMIT LEAST(100, GREATEST(1, p_limit));
$$;

-- Reuse the current entitlement-aware credit RPCs, adding only a durable
-- idempotency key around their existing transaction.
CREATE FUNCTION public.decrement_credits_once(
  p_idempotency_key text, p_user_id uuid, p_cost int, p_scout_id uuid,
  p_scout_type text, p_operation text
) RETURNS TABLE(balance int, owner text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_balance int; v_owner text; v_usage_id uuid;
BEGIN
  IF length(trim(COALESCE(p_idempotency_key, ''))) = 0 THEN
    RAISE EXCEPTION 'idempotency key is required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('credit-user:' || p_user_id::text, 0));
  SELECT balance_after, credit_owner INTO v_balance, v_owner
    FROM public.usage_records WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN QUERY SELECT v_balance, v_owner; RETURN; END IF;

  SELECT d.balance, d.owner INTO v_balance, v_owner
    FROM public.decrement_credits(
      p_user_id, p_cost, p_scout_id, p_scout_type, p_operation
    ) d;
  SELECT id INTO v_usage_id FROM public.usage_records
   WHERE user_id = p_user_id AND scout_id IS NOT DISTINCT FROM p_scout_id
     AND operation = p_operation AND cost = p_cost
     AND idempotency_key IS NULL
   ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE;
  IF v_usage_id IS NULL THEN RAISE EXCEPTION 'credit usage record missing'; END IF;
  UPDATE public.usage_records
     SET idempotency_key = p_idempotency_key, balance_after = v_balance,
         credit_owner = v_owner
   WHERE id = v_usage_id;
  RETURN QUERY SELECT v_balance, v_owner;
END;
$$;

CREATE FUNCTION public.refund_credits_once(
  p_idempotency_key text, p_user_id uuid, p_cost int, p_scout_id uuid,
  p_scout_type text, p_operation text
) RETURNS TABLE(new_balance int, owner text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_balance int; v_owner text; v_usage_id uuid;
BEGIN
  IF length(trim(COALESCE(p_idempotency_key, ''))) = 0 THEN
    RAISE EXCEPTION 'idempotency key is required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('credit-user:' || p_user_id::text, 0));
  SELECT balance_after, credit_owner INTO v_balance, v_owner
    FROM public.usage_records WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN QUERY SELECT v_balance, v_owner; RETURN; END IF;

  SELECT r.new_balance, r.owner INTO v_balance, v_owner
    FROM public.refund_credits(
      p_user_id, p_cost, p_scout_id, p_scout_type, p_operation
    ) r;
  IF v_balance IS NULL THEN RETURN; END IF;
  SELECT id INTO v_usage_id FROM public.usage_records
   WHERE user_id = p_user_id AND scout_id IS NOT DISTINCT FROM p_scout_id
     AND operation = p_operation || ':refund' AND cost = -p_cost
     AND idempotency_key IS NULL
   ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE;
  IF v_usage_id IS NULL THEN RAISE EXCEPTION 'credit refund record missing'; END IF;
  UPDATE public.usage_records
     SET idempotency_key = p_idempotency_key, balance_after = v_balance,
         credit_owner = v_owner
   WHERE id = v_usage_id;
  RETURN QUERY SELECT v_balance, v_owner;
END;
$$;

DO $$
DECLARE signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.park_scout_dispatch(uuid,text)',
    'public.finish_waiting_scout_dispatch(uuid)',
    'public.reconcile_waiting_scout_dispatches()',
    'public.claim_page_workflow_run(uuid,int)',
    'public.set_page_workflow_stage(uuid,uuid,text,boolean)',
    'public.pending_page_workflow_resumes(int)',
    'public.decrement_credits_once(text,uuid,int,uuid,text,text)',
    'public.refund_credits_once(text,uuid,int,uuid,text,text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', signature);
  END LOOP;
END;
$$;
