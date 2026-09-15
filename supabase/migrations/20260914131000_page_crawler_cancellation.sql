BEGIN;

ALTER TABLE public.crawler_jobs
  DROP CONSTRAINT crawler_jobs_status_check,
  ADD CONSTRAINT crawler_jobs_status_check CHECK (status IN (
    'queued', 'batched', 'running', 'succeeded', 'fallback_required',
    'retryable_failed', 'terminal_failed', 'cancelled'
  )),
  DROP CONSTRAINT crawler_jobs_lease_state,
  ADD CONSTRAINT crawler_jobs_lease_state CHECK (
    (status IN ('running', 'fallback_required') AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  ADD COLUMN fallback_started_at timestamptz,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancellation_reason text;

-- Preview never locks or writes. Apply locks the parent and job together and
-- rechecks eligibility, so a worker claim or fallback claim has one winner.
-- Keep the original error, manifest, attempts, batch and parent links as evidence.
CREATE FUNCTION public.cancel_terminal_page_crawler_jobs(
  p_run_id uuid DEFAULT NULL, p_limit int DEFAULT 100, p_apply boolean DEFAULT false
) RETURNS TABLE (
  job_id uuid, run_id uuid, parent_status text, previous_status text,
  cancellation_reason text, applied boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_limit int := LEAST(500, GREATEST(1, COALESCE(p_limit, 100)));
  v_row record;
  v_parent record;
  v_count int := 0;
BEGIN
  IF NOT COALESCE(p_apply, false) THEN
    RETURN QUERY
    SELECT j.id, r.id, r.status, j.status, 'parent_run_terminal'::text, false
      FROM public.crawler_jobs j
      JOIN public.scout_runs r ON r.id = j.scout_run_id
      JOIN public.scouts s ON s.id = r.scout_id
     WHERE (p_run_id IS NULL OR r.id = p_run_id)
       AND j.request_kind = 'scout_run' AND r.crawler_backend = 'workflow'
       AND s.type = 'web' AND j.operation = 'scrape'
       AND r.status IN ('success', 'error', 'skipped')
       AND (r.workflow_lease_expires_at IS NULL OR r.workflow_lease_expires_at <= now())
       AND j.status IN ('queued', 'batched', 'retryable_failed', 'fallback_required')
       AND j.lease_token IS NULL AND j.lease_expires_at IS NULL
     ORDER BY r.id, j.id LIMIT v_limit;
    RETURN;
  END IF;

  -- Match fallback claiming's parent-before-child lock order. Do not wait on
  -- either a finalizer or a worker: the next reconciliation can collect it.
  FOR v_parent IN
    SELECT r.id, r.status
      FROM public.scout_runs r JOIN public.scouts s ON s.id = r.scout_id
     WHERE (p_run_id IS NULL OR r.id = p_run_id)
       AND r.crawler_backend = 'workflow' AND s.type = 'web'
       AND r.status IN ('success', 'error', 'skipped')
       AND (r.workflow_lease_expires_at IS NULL OR r.workflow_lease_expires_at <= now())
       AND EXISTS (
         SELECT 1 FROM public.crawler_jobs j
          WHERE j.scout_run_id = r.id AND j.request_kind = 'scout_run'
            AND j.operation = 'scrape'
            AND j.status IN ('queued', 'batched', 'retryable_failed', 'fallback_required')
            AND j.lease_token IS NULL AND j.lease_expires_at IS NULL
       )
     ORDER BY r.id LIMIT v_limit FOR UPDATE OF r SKIP LOCKED
  LOOP
    FOR v_row IN
      SELECT j.id, j.status
        FROM public.crawler_jobs j
       WHERE j.scout_run_id = v_parent.id AND j.request_kind = 'scout_run'
         AND j.operation = 'scrape'
         AND j.status IN ('queued', 'batched', 'retryable_failed', 'fallback_required')
         AND j.lease_token IS NULL AND j.lease_expires_at IS NULL
       ORDER BY j.id LIMIT v_limit - v_count FOR UPDATE OF j SKIP LOCKED
    LOOP
      UPDATE public.crawler_jobs j
         SET status = 'cancelled', cancellation_reason = 'parent_run_terminal',
             cancelled_at = now(), completed_at = COALESCE(j.completed_at, now()), updated_at = now()
       WHERE j.id = v_row.id;
      RETURN QUERY SELECT v_row.id, v_parent.id, v_parent.status,
        v_row.status, 'parent_run_terminal'::text, true;
      v_count := v_count + 1;
    END LOOP;
    EXIT WHEN v_count >= v_limit;
  END LOOP;
END;
$$;

-- The provider call starts only after this durable, one-attempt claim. Expiry
-- never grants a second provider attempt: reconciliation records the lost call.
CREATE FUNCTION public.claim_page_crawler_fallback(
  p_job_id uuid, p_lease_seconds int DEFAULT 600
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run_id uuid;
  v_token uuid := gen_random_uuid();
BEGIN
  SELECT j.scout_run_id INTO v_run_id FROM public.crawler_jobs j WHERE j.id = p_job_id;
  PERFORM 1 FROM public.scout_runs r JOIN public.scouts s ON s.id = r.scout_id
   WHERE r.id = v_run_id AND r.status = 'running'
     AND r.crawler_backend = 'workflow' AND s.type = 'web'
   FOR UPDATE OF r;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE public.crawler_jobs j
     SET lease_token = v_token,
         lease_expires_at = now() + make_interval(secs => LEAST(1800, GREATEST(60, COALESCE(p_lease_seconds, 600)))),
         fallback_started_at = now(), updated_at = now()
   WHERE j.id = p_job_id AND j.scout_run_id = v_run_id
     AND j.request_kind = 'scout_run' AND j.operation = 'scrape'
     AND j.status = 'fallback_required' AND j.fallback_started_at IS NULL
     AND j.lease_token IS NULL AND j.lease_expires_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN v_token;
END;
$$;

-- Proxy handoff still closes an unleased job without making a provider call.
-- Native Page callers must present the token acquired before any fallback spend.
DROP FUNCTION public.complete_crawler_fallback(uuid, boolean, jsonb, text);
CREATE FUNCTION public.complete_crawler_fallback(
  p_job_id uuid, p_ok boolean, p_manifest jsonb DEFAULT NULL,
  p_error text DEFAULT NULL, p_lease_token uuid DEFAULT NULL
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
           THEN p_manifest || jsonb_build_object('provider', 'firecrawl') ELSE NULL END,
         error_class = CASE WHEN p_ok THEN NULL ELSE 'fallback_terminal' END,
         error_message = CASE WHEN p_ok THEN NULL ELSE left(COALESCE(p_error, 'fallback failed'), 1500) END,
         lease_token = NULL, lease_expires_at = NULL,
         updated_at = now(), completed_at = now()
   WHERE j.id = p_job_id AND j.status = 'fallback_required'
     AND ((p_lease_token IS NOT NULL AND j.lease_token = p_lease_token)
       OR (p_lease_token IS NULL AND j.lease_token IS NULL AND NOT EXISTS (
         SELECT 1 FROM public.scout_runs r JOIN public.scouts s ON s.id = r.scout_id
          WHERE r.id = j.scout_run_id AND r.crawler_backend = 'workflow' AND s.type = 'web'
       )));
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_terminal_page_crawler_jobs(uuid, int, boolean),
  public.claim_page_crawler_fallback(uuid, int),
  public.complete_crawler_fallback(uuid, boolean, jsonb, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_terminal_page_crawler_jobs(uuid, int, boolean),
  public.claim_page_crawler_fallback(uuid, int),
  public.complete_crawler_fallback(uuid, boolean, jsonb, text, uuid)
  TO service_role;

-- Recheck the native parent when a delayed Render batch claims its first lease.
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
         AND NOT EXISTS (
           SELECT 1 FROM public.scout_runs r JOIN public.scouts s ON s.id = r.scout_id
            WHERE r.id = j.scout_run_id AND j.request_kind = 'scout_run'
              AND r.crawler_backend = 'workflow' AND s.type = 'web'
              AND r.status IN ('success', 'error', 'skipped')
         )
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
      AND NOT EXISTS (
        SELECT 1 FROM public.scout_runs r JOIN public.scouts s ON s.id = r.scout_id
         WHERE r.id = j.scout_run_id AND j.request_kind = 'scout_run'
           AND r.crawler_backend = 'workflow' AND s.type = 'web'
           AND r.status IN ('success', 'error', 'skipped')
      )
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
     WHERE j.status IN ('queued', 'retryable_failed')
       AND j.available_at <= now()
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

-- Old dispatchers do not activate cancellation merely by applying this schema.
-- Deploy the explicit opt-in dispatcher only after draining old Page transports.
DROP FUNCTION public.reconcile_crawler_jobs();
CREATE FUNCTION public.reconcile_crawler_jobs(
  p_cancel_terminal_page_jobs boolean DEFAULT false
)
RETURNS TABLE (requeued int, terminalized int, batches_finished int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_requeued int := 0;
  v_terminalized int := 0;
  v_batches_finished int := 0;
  v_batches_released int := 0;
  v_expired record;
BEGIN
  -- A claimed fallback is one provider attempt, even if the caller dies. Do
  -- not requeue it or rewrite it as a successful retrieval.
  WITH changed AS (
    UPDATE public.crawler_jobs j
       SET status = 'terminal_failed', lease_token = NULL, lease_expires_at = NULL,
           error_class = 'fallback_terminal',
           error_message = concat_ws('; ', j.error_message, 'fallback lease expired; provider outcome unknown'),
           updated_at = now(), completed_at = now()
     WHERE j.status = 'fallback_required' AND j.lease_expires_at <= now()
    RETURNING 1
  ) SELECT count(*)::int INTO v_terminalized FROM changed;

  IF p_cancel_terminal_page_jobs THEN
    PERFORM * FROM public.cancel_terminal_page_crawler_jobs(NULL, 500, true);
  END IF;
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

  FOR v_expired IN
    SELECT j.id, j.lease_token FROM public.crawler_jobs j
     WHERE j.status = 'running' AND j.lease_expires_at <= now()
       AND j.attempts >= j.max_attempts
     FOR UPDATE OF j SKIP LOCKED
  LOOP
    IF public.complete_crawler_job(v_expired.id, v_expired.lease_token, false,
      NULL, 'retryable', 'crawler attempts exhausted after lease expiry')
      AND (SELECT status FROM public.crawler_jobs WHERE id = v_expired.id) = 'terminal_failed' THEN
      v_terminalized := v_terminalized + 1;
    END IF;
  END LOOP;

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

  -- Lease recovery and stale batch release may expose additional unused jobs.
  IF p_cancel_terminal_page_jobs THEN
    PERFORM * FROM public.cancel_terminal_page_crawler_jobs(NULL, 500, true);
  END IF;

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

REVOKE ALL ON FUNCTION public.reconcile_crawler_jobs(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_crawler_jobs(boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_waiting_scout_dispatches()
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
  RETURN v_total;
END;
$$;

CREATE OR REPLACE FUNCTION public.pending_page_workflow_resumes(p_limit int DEFAULT 100)
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
          AND (j.status IN ('queued', 'batched', 'running', 'retryable_failed')
              OR (j.status = 'fallback_required' AND j.lease_expires_at > now()))
     )
   ORDER BY r.workflow_progressed_at, r.id
   LIMIT LEAST(100, GREATEST(1, p_limit));
$$;

COMMIT;
