-- Atomic Render task-start reservation and acknowledgement. The endpoint is
-- deployed without a cron until Gate B passes.

CREATE INDEX crawler_batches_submission_budget_idx
  ON public.crawler_batches(submission_reserved_at)
  WHERE submission_reserved_at IS NOT NULL;

CREATE UNIQUE INDEX crawler_batches_render_task_run_unique
  ON public.crawler_batches(render_task_run_id)
  WHERE render_task_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.reserve_crawler_batch_submission(
  p_batch_id uuid,
  p_limit int DEFAULT 28
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch public.crawler_batches%ROWTYPE;
  v_token uuid := gen_random_uuid();
BEGIN
  IF p_limit < 1 OR p_limit > 28 THEN
    RAISE EXCEPTION 'invalid start limit';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('render-task-start-budget', 0));
  SELECT * INTO v_batch
    FROM public.crawler_batches
   WHERE id = p_batch_id
   FOR UPDATE;
  IF NOT FOUND OR v_batch.status <> 'pending' THEN RETURN NULL; END IF;
  IF v_batch.submission_reserved_at IS NOT NULL THEN RETURN NULL; END IF;
  IF (
    SELECT count(*) FROM public.crawler_batches
     WHERE submission_reserved_at > now() - interval '60 seconds'
  ) >= p_limit THEN
    RETURN NULL;
  END IF;
  UPDATE public.crawler_batches
     SET submission_reserved_at = now(),
         submission_reservation_token = v_token,
         updated_at = now()
   WHERE id = p_batch_id;
  RETURN v_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_crawler_batch_submitted(
  p_batch_id uuid,
  p_reservation_token uuid,
  p_render_task_run_id text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_changed int;
BEGIN
  IF length(trim(COALESCE(p_render_task_run_id, ''))) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid Render task run id';
  END IF;
  UPDATE public.crawler_batches b
     SET render_task_run_id = p_render_task_run_id,
         submitted_at = now(),
         status = CASE WHEN b.status = 'running' THEN 'running' ELSE 'submitted' END,
         updated_at = now()
   WHERE b.id = p_batch_id
     AND b.status IN ('pending', 'running')
     AND b.render_task_run_id IS NULL
     AND b.submission_reservation_token = p_reservation_token;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_crawler_batch(
  p_batch_id uuid,
  p_reservation_token uuid DEFAULT NULL,
  p_error text DEFAULT 'render submission not started'
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch public.crawler_batches%ROWTYPE;
BEGIN
  SELECT * INTO v_batch
    FROM public.crawler_batches
   WHERE id = p_batch_id
   FOR UPDATE;
  IF NOT FOUND OR v_batch.status <> 'pending' THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM public.crawler_jobs j
     WHERE j.batch_id = p_batch_id AND j.status <> 'batched'
  ) THEN
    RETURN false;
  END IF;
  IF v_batch.submission_reservation_token IS NOT NULL
     AND v_batch.submission_reservation_token IS DISTINCT FROM p_reservation_token THEN
    RETURN false;
  END IF;

  UPDATE public.crawler_jobs
     SET status = 'queued', batch_id = NULL, updated_at = now()
   WHERE batch_id = p_batch_id AND status = 'batched';
  UPDATE public.crawler_batches
     SET status = 'failed', completed_at = now(),
         render_metrics = render_metrics || jsonb_build_object(
           'submission_error', left(COALESCE(p_error, 'submission failed'), 300)
         ),
         updated_at = now()
   WHERE id = p_batch_id;
  RETURN true;
END;
$$;

-- Record one polled Render state. Any terminal task that never claimed its
-- batch safely releases still-batched jobs; active leases remain ledger-owned.
CREATE OR REPLACE FUNCTION public.reconcile_crawler_render_run(
  p_batch_id uuid,
  p_render_task_run_id text,
  p_status text,
  p_metrics jsonb DEFAULT '{}'::jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch public.crawler_batches%ROWTYPE;
BEGIN
  IF p_status NOT IN (
    'canceled', 'completed', 'failed', 'paused', 'pending', 'running', 'succeeded'
  ) THEN
    RAISE EXCEPTION 'invalid Render task status';
  END IF;
  SELECT * INTO v_batch
    FROM public.crawler_batches
   WHERE id = p_batch_id
     AND render_task_run_id = p_render_task_run_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE public.crawler_batches
     SET render_metrics = COALESCE(p_metrics, '{}'::jsonb),
         render_metrics_checked_at = now(),
         render_terminal = p_status IN ('failed', 'canceled', 'completed', 'succeeded'),
         updated_at = now()
   WHERE id = p_batch_id;

  IF p_status IN ('failed', 'canceled', 'completed', 'succeeded')
     AND v_batch.status = 'submitted' THEN
    UPDATE public.crawler_jobs
       SET status = 'queued', batch_id = NULL, updated_at = now()
     WHERE batch_id = p_batch_id AND status = 'batched';
    UPDATE public.crawler_batches
       SET status = 'failed', completed_at = now(), updated_at = now()
     WHERE id = p_batch_id;
  END IF;
  RETURN true;
END;
$$;

DO $$
DECLARE
  v_signature text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.reserve_crawler_batch_submission(uuid,integer)',
    'public.mark_crawler_batch_submitted(uuid,uuid,text)',
    'public.release_crawler_batch(uuid,uuid,text)',
    'public.reconcile_crawler_render_run(uuid,text,text,jsonb)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_signature);
  END LOOP;
END;
$$;
