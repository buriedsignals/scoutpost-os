-- Durable, service-role-only ledger for Render Workflow crawler jobs.
-- This migration is additive. Production callers remain on scrape-service
-- until the Gate B routing migration is applied and explicitly enabled.

CREATE TABLE public.crawler_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation text NOT NULL CHECK (operation IN ('scrape', 'snapshot', 'parse_pdf')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitted', 'running', 'complete', 'failed')),
  render_task_run_id text,
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  submitted_at timestamptz,
  completed_at timestamptz,
  render_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  render_metrics_checked_at timestamptz,
  render_terminal boolean NOT NULL DEFAULT false,
  submission_reserved_at timestamptz,
  submission_reservation_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.crawler_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  request_kind text NOT NULL CHECK (request_kind IN (
    'scout_run', 'ingest', 'baseline', 'preview', 'benchmark'
  )),
  tenant_key text NOT NULL CHECK (length(trim(tenant_key)) BETWEEN 1 AND 200),
  continuation_key text NOT NULL
    CHECK (length(trim(continuation_key)) BETWEEN 1 AND 500),
  scout_run_id uuid REFERENCES public.scout_runs(id) ON DELETE CASCADE,
  scout_id uuid REFERENCES public.scouts(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  batch_id uuid REFERENCES public.crawler_batches(id) ON DELETE SET NULL,
  operation text NOT NULL CHECK (operation IN ('scrape', 'snapshot', 'parse_pdf')),
  pipeline_stage text NOT NULL CHECK (length(trim(pipeline_stage)) BETWEEN 1 AND 100),
  url text NOT NULL CHECK (
    length(url) BETWEEN 8 AND 8192 AND url ~* '^https?://'
  ),
  options jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(options) = 'object'),
  priority int NOT NULL DEFAULT 0 CHECK (priority BETWEEN -1000 AND 1000),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'batched', 'running', 'succeeded', 'fallback_required',
    'retryable_failed', 'terminal_failed'
  )),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts int NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at timestamptz NOT NULL DEFAULT now(),
  batched_at timestamptz,
  started_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  result_manifest jsonb,
  error_class text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT crawler_jobs_scout_context CHECK (
    request_kind <> 'scout_run'
    OR (scout_run_id IS NOT NULL AND scout_id IS NOT NULL AND user_id IS NOT NULL)
  ),
  CONSTRAINT crawler_jobs_lease_state CHECK (
    (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX crawler_jobs_dispatch_idx
  ON public.crawler_jobs (operation, priority DESC, available_at, created_at)
  WHERE status IN ('queued', 'retryable_failed');
CREATE INDEX crawler_jobs_run_idx
  ON public.crawler_jobs (scout_run_id, pipeline_stage, status);
CREATE INDEX crawler_jobs_continuation_idx
  ON public.crawler_jobs (continuation_key, pipeline_stage, status);
CREATE INDEX crawler_jobs_batch_idx
  ON public.crawler_jobs (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX crawler_jobs_lease_expiry_idx
  ON public.crawler_jobs (lease_expires_at) WHERE status = 'running';
CREATE INDEX crawler_jobs_utility_admission_idx
  ON public.crawler_jobs (tenant_key, created_at)
  WHERE request_kind <> 'scout_run';
CREATE INDEX crawler_jobs_utility_global_idx
  ON public.crawler_jobs (created_at)
  WHERE request_kind <> 'scout_run';

ALTER TABLE public.crawler_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crawler_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crawler_jobs, public.crawler_batches
  FROM PUBLIC, anon, authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('crawler-results', 'crawler-results', false, 52428800)
ON CONFLICT (id) DO UPDATE
SET public = false, file_size_limit = EXCLUDED.file_size_limit;

-- Idempotent enqueue. A duplicate returns the original row without changing
-- its state, attempts, timing, or terminal result.
CREATE OR REPLACE FUNCTION public.enqueue_crawler_job(
  p_dedupe_key text,
  p_request_kind text,
  p_tenant_key text,
  p_continuation_key text,
  p_operation text,
  p_pipeline_stage text,
  p_url text,
  p_options jsonb DEFAULT '{}'::jsonb,
  p_priority int DEFAULT 0,
  p_max_attempts int DEFAULT 3,
  p_scout_run_id uuid DEFAULT NULL,
  p_scout_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
) RETURNS public.crawler_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.crawler_jobs%ROWTYPE;
BEGIN
  IF length(trim(COALESCE(p_dedupe_key, ''))) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid crawler dedupe key';
  END IF;

  INSERT INTO public.crawler_jobs (
    dedupe_key, request_kind, tenant_key, continuation_key,
    operation, pipeline_stage, url, options, priority, max_attempts,
    scout_run_id, scout_id, user_id
  ) VALUES (
    p_dedupe_key, p_request_kind, p_tenant_key, p_continuation_key,
    p_operation, p_pipeline_stage, p_url, COALESCE(p_options, '{}'::jsonb),
    LEAST(1000, GREATEST(-1000, COALESCE(p_priority, 0))),
    LEAST(10, GREATEST(1, COALESCE(p_max_attempts, 3))),
    p_scout_run_id, p_scout_id, p_user_id
  )
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING * INTO v_job;

  IF v_job.id IS NULL THEN
    SELECT * INTO STRICT v_job
      FROM public.crawler_jobs
     WHERE dedupe_key = p_dedupe_key;
  END IF;
  RETURN v_job;
END;
$$;

-- Utility admission is deliberately a small atomic cost guard, not a product
-- quota system. Identity, request kind, and priority are derived by the Edge
-- Function and never accepted from an end-user request body.
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
  IF p_request_kind NOT IN ('ingest', 'baseline', 'preview') THEN
    RAISE EXCEPTION 'invalid utility request kind';
  END IF;
  IF p_global_daily_limit NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'invalid utility daily limit';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('crawler-utility:' || p_tenant_key, 0));

  SELECT * INTO v_job FROM public.crawler_jobs WHERE dedupe_key = p_dedupe_key;
  IF FOUND THEN
    RETURN v_job;
  END IF;

  IF (
    SELECT count(*) FROM public.crawler_jobs
     WHERE tenant_key = p_tenant_key
       AND request_kind <> 'scout_run'
       AND status IN ('queued', 'batched', 'running', 'retryable_failed', 'fallback_required')
  ) >= 20 THEN
    RAISE EXCEPTION 'crawler utility tenant admission exhausted';
  END IF;

  IF (
    SELECT count(*) FROM public.crawler_jobs
     WHERE request_kind <> 'scout_run'
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

-- Form all batches for one operation in one fair ordering. Tenant rank is
-- computed across the complete dispatch cycle, not reset for each batch.
CREATE OR REPLACE FUNCTION public.create_crawler_batches(
  p_operation text,
  p_batch_size int,
  p_job_limit int
) RETURNS TABLE (batch_id uuid, job_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch_size int := LEAST(20, GREATEST(1, COALESCE(p_batch_size, 1)));
  v_job_limit int := LEAST(600, GREATEST(1, COALESCE(p_job_limit, 1)));
BEGIN
  IF p_operation NOT IN ('scrape', 'snapshot', 'parse_pdf') THEN
    RAISE EXCEPTION 'invalid crawler operation';
  END IF;
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('crawler-dispatch:' || p_operation, 0)
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH eligible AS MATERIALIZED (
    SELECT j.id, j.tenant_key, j.available_at, j.created_at,
      GREATEST(
        LEAST(j.priority, 100),
        LEAST(100, FLOOR(EXTRACT(EPOCH FROM (now() - j.available_at)) / 60) * 20)
      )::int AS effective_priority
    FROM public.crawler_jobs j
    WHERE j.operation = p_operation
      AND j.status IN ('queued', 'retryable_failed')
      AND j.available_at <= now()
  ), ranked AS (
    SELECT e.*,
      row_number() OVER (
        PARTITION BY e.tenant_key, e.effective_priority
        ORDER BY e.available_at, e.created_at, e.id
      ) AS tenant_rank
    FROM eligible e
  ), ordered AS (
    SELECT r.*, row_number() OVER (
      ORDER BY r.effective_priority DESC, r.tenant_rank,
               r.available_at, r.created_at, r.id
    ) AS dispatch_order
    FROM ranked r
  ), locked AS MATERIALIZED (
    SELECT j.id, o.dispatch_order
      FROM ordered o
      JOIN public.crawler_jobs j ON j.id = o.id
     ORDER BY o.dispatch_order
     FOR UPDATE OF j SKIP LOCKED
     LIMIT v_job_limit
  ), grouped AS MATERIALIZED (
    SELECT
      ((l.dispatch_order - 1) / v_batch_size)::int AS batch_no,
      gen_random_uuid() AS new_batch_id,
      array_agg(l.id ORDER BY l.dispatch_order) AS ids
    FROM locked l
    GROUP BY ((l.dispatch_order - 1) / v_batch_size)::int
  ), inserted AS (
    INSERT INTO public.crawler_batches (id, operation)
    SELECT g.new_batch_id, p_operation FROM grouped g
    RETURNING id
  ), assigned AS (
    UPDATE public.crawler_jobs j
       SET batch_id = g.new_batch_id,
           status = 'batched',
           batched_at = now(),
           updated_at = now()
      FROM grouped g
     WHERE j.id = ANY(g.ids)
    RETURNING j.id
  )
  SELECT g.new_batch_id, g.ids
    FROM grouped g
    JOIN inserted i ON i.id = g.new_batch_id
   ORDER BY g.batch_no;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_crawler_batch(
  p_batch_id uuid,
  p_lease_seconds int DEFAULT 600
) RETURNS TABLE (
  id uuid,
  lease_token uuid,
  request_kind text,
  tenant_key text,
  continuation_key text,
  operation text,
  pipeline_stage text,
  url text,
  options jsonb,
  attempt int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status text;
  v_lease_seconds int := LEAST(1800, GREATEST(60, COALESCE(p_lease_seconds, 600)));
BEGIN
  SELECT b.status INTO v_status
    FROM public.crawler_batches b
   WHERE b.id = p_batch_id
   FOR UPDATE;

  IF NOT FOUND OR v_status NOT IN ('pending', 'submitted', 'running') THEN
    RETURN;
  END IF;

  IF v_status IN ('pending', 'submitted') THEN
    UPDATE public.crawler_batches
       SET status = 'running', attempts = attempts + 1, updated_at = now()
     WHERE crawler_batches.id = p_batch_id;

    RETURN QUERY
    WITH claimable AS (
      SELECT j.id
        FROM public.crawler_jobs j
       WHERE j.batch_id = p_batch_id AND j.status = 'batched'
       ORDER BY j.created_at, j.id
       FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE public.crawler_jobs j
         SET status = 'running', attempts = j.attempts + 1,
             started_at = now(),
             lease_token = gen_random_uuid(),
             lease_expires_at = now() + make_interval(secs => v_lease_seconds),
             updated_at = now()
        FROM claimable c
       WHERE j.id = c.id
      RETURNING j.*
    )
    SELECT c.id, c.lease_token, c.request_kind, c.tenant_key,
           c.continuation_key, c.operation, c.pipeline_stage, c.url,
           c.options, c.attempts
      FROM claimed c
     ORDER BY c.created_at, c.id;
    RETURN;
  END IF;

  -- A duplicate Render process receives the same live attempts. It can race
  -- work safely, but cannot create a second lease or increment attempts.
  RETURN QUERY
  WITH renewed AS (
    UPDATE public.crawler_jobs j
       SET lease_expires_at = now() + make_interval(secs => v_lease_seconds),
           updated_at = now()
     WHERE j.batch_id = p_batch_id
       AND j.status = 'running'
       AND j.lease_expires_at > now()
    RETURNING j.*
  )
  SELECT r.id, r.lease_token, r.request_kind, r.tenant_key,
         r.continuation_key, r.operation, r.pipeline_stage, r.url,
         r.options, r.attempts
    FROM renewed r
   ORDER BY r.created_at, r.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_crawler_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_ok boolean,
  p_manifest jsonb DEFAULT NULL,
  p_error_class text DEFAULT NULL,
  p_error text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_changed int;
BEGIN
  IF p_ok AND (p_manifest IS NULL OR jsonb_typeof(p_manifest) <> 'object') THEN
    RAISE EXCEPTION 'successful crawler completion requires a manifest';
  END IF;
  IF NOT p_ok AND p_error_class NOT IN ('anti_bot', 'timeout', 'retryable', 'terminal') THEN
    RAISE EXCEPTION 'invalid crawler error class';
  END IF;

  UPDATE public.crawler_jobs j
     SET status = CASE
           WHEN p_ok THEN 'succeeded'
           WHEN p_error_class = 'anti_bot' THEN 'fallback_required'
           WHEN p_error_class IN ('timeout', 'retryable') AND j.attempts < j.max_attempts
             THEN 'retryable_failed'
           ELSE 'terminal_failed'
         END,
         batch_id = CASE
           WHEN NOT p_ok AND p_error_class IN ('timeout', 'retryable')
                AND j.attempts < j.max_attempts THEN NULL
           ELSE j.batch_id
         END,
         available_at = CASE
           WHEN NOT p_ok AND p_error_class IN ('timeout', 'retryable')
                AND j.attempts < j.max_attempts
             THEN now() + make_interval(secs => LEAST(300, 5 * power(2, j.attempts)::int))
           ELSE j.available_at
         END,
         result_manifest = CASE WHEN p_ok THEN p_manifest ELSE NULL END,
         error_class = CASE WHEN p_ok THEN NULL ELSE p_error_class END,
         error_message = CASE WHEN p_ok THEN NULL ELSE left(COALESCE(p_error, 'crawl failed'), 1500) END,
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = now(),
         completed_at = CASE
           WHEN p_ok OR p_error_class IN ('anti_bot', 'terminal')
                OR (p_error_class IN ('timeout', 'retryable') AND j.attempts >= j.max_attempts)
             THEN now()
           ELSE NULL
         END
   WHERE j.id = p_job_id
     AND j.status = 'running'
     AND j.lease_token = p_lease_token;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_crawler_fallback(
  p_job_id uuid,
  p_ok boolean,
  p_manifest jsonb DEFAULT NULL,
  p_error text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_changed int;
BEGIN
  IF p_ok AND (p_manifest IS NULL OR jsonb_typeof(p_manifest) <> 'object') THEN
    RAISE EXCEPTION 'successful fallback requires a manifest';
  END IF;
  UPDATE public.crawler_jobs j
     SET status = CASE WHEN p_ok THEN 'succeeded' ELSE 'terminal_failed' END,
         result_manifest = CASE WHEN p_ok
           THEN p_manifest || jsonb_build_object('provider', 'firecrawl')
           ELSE NULL END,
         error_class = CASE WHEN p_ok THEN NULL ELSE 'fallback_terminal' END,
         error_message = CASE WHEN p_ok THEN NULL ELSE left(COALESCE(p_error, 'fallback failed'), 1500) END,
         updated_at = now(),
         completed_at = now()
   WHERE j.id = p_job_id
     AND j.status = 'fallback_required';
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed = 1;
END;
$$;

-- Reconcile lost task processes and close batches whose active work is gone.
CREATE OR REPLACE FUNCTION public.reconcile_crawler_jobs()
RETURNS TABLE (requeued int, terminalized int, batches_finished int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_requeued int := 0;
  v_terminalized int := 0;
  v_batches_finished int := 0;
  v_batches_released int := 0;
BEGIN
  WITH changed AS (
    UPDATE public.crawler_jobs j
       SET status = 'retryable_failed', batch_id = NULL,
           available_at = now() + make_interval(secs => LEAST(300, 5 * power(2, j.attempts)::int)),
           lease_token = NULL, lease_expires_at = NULL,
           error_class = 'timeout', error_message = 'crawler lease expired',
           updated_at = now()
     WHERE j.status = 'running'
       AND j.lease_expires_at <= now()
       AND j.attempts < j.max_attempts
    RETURNING 1
  ) SELECT count(*)::int INTO v_requeued FROM changed;

  WITH changed AS (
    UPDATE public.crawler_jobs j
       SET status = 'terminal_failed', lease_token = NULL,
           lease_expires_at = NULL, error_class = 'timeout',
           error_message = 'crawler attempts exhausted after lease expiry',
           updated_at = now(), completed_at = now()
     WHERE j.status = 'running'
       AND j.lease_expires_at <= now()
       AND j.attempts >= j.max_attempts
    RETURNING 1
  ) SELECT count(*)::int INTO v_terminalized FROM changed;

  -- Release a dispatcher crash quickly, but give an ambiguous Render POST a
  -- full fifteen minutes to claim before making its jobs eligible again.
  WITH stale AS (
    UPDATE public.crawler_batches b
       SET status = 'failed', completed_at = now(), updated_at = now()
     WHERE (
       b.status = 'pending' AND (
         (b.submission_reserved_at IS NULL
           AND b.created_at <= now() - interval '2 minutes')
         OR (b.submission_reserved_at <= now() - interval '15 minutes')
       )
     ) OR (
       b.status = 'submitted'
       AND b.submitted_at <= now() - interval '15 minutes'
     )
    RETURNING b.id
  ), released AS (
    UPDATE public.crawler_jobs j
       SET status = 'queued', batch_id = NULL, batched_at = NULL,
           updated_at = now()
      FROM stale s
     WHERE j.batch_id = s.id AND j.status = 'batched'
    RETURNING 1
  )
  SELECT count(*)::int INTO v_batches_released FROM stale;

  WITH changed AS (
    UPDATE public.crawler_batches b
       SET status = 'complete', completed_at = COALESCE(b.completed_at, now()),
           updated_at = now()
     WHERE b.status IN ('submitted', 'running')
       AND NOT EXISTS (
         SELECT 1 FROM public.crawler_jobs j
          WHERE j.batch_id = b.id AND j.status IN ('batched', 'running')
       )
    RETURNING 1
  ) SELECT count(*)::int INTO v_batches_finished FROM changed;

  v_batches_finished := v_batches_finished + v_batches_released;

  RETURN QUERY SELECT v_requeued, v_terminalized, v_batches_finished;
END;
$$;

DO $$
DECLARE
  v_signature text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.enqueue_crawler_job(text,text,text,text,text,text,text,jsonb,integer,integer,uuid,uuid,uuid)',
    'public.admit_and_enqueue_crawler_utility(text,text,text,text,text,text,text,jsonb,integer)',
    'public.create_crawler_batches(text,integer,integer)',
    'public.claim_crawler_batch(uuid,integer)',
    'public.complete_crawler_job(uuid,uuid,boolean,jsonb,text,text)',
    'public.complete_crawler_fallback(uuid,boolean,jsonb,text)',
    'public.reconcile_crawler_jobs()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_signature);
  END LOOP;
END;
$$;
