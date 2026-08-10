-- Hosted compatibility traffic keeps the existing /scrape and /parse
-- contract while using the durable Workflow crawler ledger.  The request kind
-- is intentionally distinct so result artifacts can be swept without touching
-- Page Scout or user-facing utility jobs.
ALTER TABLE public.crawler_jobs
  ADD CONSTRAINT crawler_jobs_request_kind_check_v2 CHECK (request_kind IN (
    'scout_run', 'ingest', 'baseline', 'preview', 'benchmark', 'proxy'
  )) NOT VALID;

ALTER TABLE public.crawler_jobs
  VALIDATE CONSTRAINT crawler_jobs_request_kind_check_v2;

ALTER TABLE public.crawler_jobs
  DROP CONSTRAINT crawler_jobs_request_kind_check;

ALTER TABLE public.crawler_jobs
  RENAME CONSTRAINT crawler_jobs_request_kind_check_v2
  TO crawler_jobs_request_kind_check;

CREATE INDEX crawler_jobs_proxy_cleanup_idx
  ON public.crawler_jobs (completed_at, id)
  WHERE request_kind = 'proxy' AND result_manifest IS NOT NULL;

CREATE OR REPLACE FUNCTION public.admit_and_enqueue_crawler_utility(
  p_dedupe_key text,
  p_request_kind text,
  p_tenant_key text,
  p_continuation_key text,
  p_operation text,
  p_pipeline_stage text,
  p_url text,
  p_options jsonb DEFAULT '{}'::jsonb,
  p_global_daily_limit int DEFAULT 10000
) RETURNS public.crawler_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.crawler_jobs%ROWTYPE;
BEGIN
  IF p_request_kind NOT IN ('ingest', 'baseline', 'preview', 'proxy') THEN
    RAISE EXCEPTION 'invalid utility request kind';
  END IF;
  IF p_global_daily_limit NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'invalid utility daily limit';
  END IF;

  -- Fixed lock order makes the rolling 24-hour ceiling atomic across tenants.
  PERFORM pg_advisory_xact_lock(hashtextextended('crawler-utility:global', 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('crawler-utility:' || p_tenant_key, 0));

  SELECT * INTO v_job FROM public.crawler_jobs WHERE dedupe_key = p_dedupe_key;
  IF FOUND THEN
    RETURN v_job;
  END IF;

  IF (
    SELECT count(*) FROM public.crawler_jobs
     WHERE tenant_key = p_tenant_key
       AND request_kind <> 'scout_run'
       AND NOT (
         request_kind = 'proxy' AND options->>'admission_class' = 'scout'
       )
       AND status IN ('queued', 'batched', 'running', 'retryable_failed', 'fallback_required')
  ) >= 20 THEN
    RAISE EXCEPTION 'crawler utility tenant admission exhausted';
  END IF;

  IF (
    SELECT count(*) FROM public.crawler_jobs
     WHERE request_kind <> 'scout_run'
       AND NOT (
         request_kind = 'proxy' AND options->>'admission_class' = 'scout'
       )
       AND created_at >= now() - interval '24 hours'
  ) >= p_global_daily_limit THEN
    RAISE EXCEPTION 'crawler utility daily admission exhausted';
  END IF;

  SELECT * INTO v_job FROM public.enqueue_crawler_job(
    p_dedupe_key, p_request_kind, p_tenant_key, p_continuation_key,
    p_operation, p_pipeline_stage, p_url, p_options, 0, 3,
    NULL, NULL, NULL
  );
  RETURN v_job;
END;
$$;

-- Compatibility requests are synchronous. Form only the caller's job rather
-- than spending its immediate task start on unrelated queued work. The normal
-- scheduled dispatcher remains the fleet-wide recovery owner.
CREATE OR REPLACE FUNCTION public.create_crawler_proxy_batch(
  p_job_id uuid
) RETURNS TABLE (batch_id uuid, job_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_operation text;
  v_status text;
  v_batch_id uuid;
  v_batch_status text;
  v_changed int;
BEGIN
  SELECT j.operation INTO v_operation
    FROM public.crawler_jobs j
   WHERE j.id = p_job_id AND j.request_kind = 'proxy';
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('crawler-dispatch:' || v_operation, 0)
  ) THEN
    RETURN;
  END IF;

  SELECT j.status, j.batch_id, j.operation
    INTO v_status, v_batch_id, v_operation
    FROM public.crawler_jobs j
   WHERE j.id = p_job_id AND j.request_kind = 'proxy'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_batch_id IS NOT NULL THEN
    SELECT b.status INTO v_batch_status
      FROM public.crawler_batches b
     WHERE b.id = v_batch_id;
    IF v_status = 'batched' AND v_batch_status = 'pending' THEN
      RETURN QUERY SELECT v_batch_id, ARRAY[p_job_id];
    END IF;
    RETURN;
  END IF;

  IF v_status NOT IN ('queued', 'retryable_failed') OR NOT EXISTS (
    SELECT 1 FROM public.crawler_jobs j
     WHERE j.id = p_job_id AND j.available_at <= now()
  ) THEN
    RETURN;
  END IF;

  v_batch_id := gen_random_uuid();
  INSERT INTO public.crawler_batches (id, operation)
  VALUES (v_batch_id, v_operation);

  UPDATE public.crawler_jobs j
     SET batch_id = v_batch_id,
         status = 'batched',
         batched_at = now(),
         updated_at = now()
   WHERE j.id = p_job_id
     AND j.request_kind = 'proxy'
     AND j.status IN ('queued', 'retryable_failed')
     AND j.available_at <= now()
     AND j.batch_id IS NULL;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed <> 1 THEN
    DELETE FROM public.crawler_batches WHERE id = v_batch_id;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_batch_id, ARRAY[p_job_id];
END;
$$;

REVOKE ALL ON FUNCTION public.admit_and_enqueue_crawler_utility(
  text,text,text,text,text,text,text,jsonb,integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_and_enqueue_crawler_utility(
  text,text,text,text,text,text,text,jsonb,integer
) TO service_role;

REVOKE ALL ON FUNCTION public.create_crawler_proxy_batch(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_crawler_proxy_batch(uuid)
  TO service_role;
