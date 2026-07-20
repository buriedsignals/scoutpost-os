-- 00087_scout_dispatch_queue.sql
-- Put scrape-heavy scout dispatch behind a durable, globally capacity-limited
-- queue. Social and transport scouts remain on the immediate dispatch path.

CREATE TABLE public.scout_dispatch_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scout_run_id uuid NOT NULL UNIQUE
    REFERENCES public.scout_runs(id) ON DELETE CASCADE,
  scout_id uuid NOT NULL REFERENCES public.scouts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scout_type text NOT NULL CHECK (scout_type IN ('web', 'beat', 'civic')),
  source text NOT NULL DEFAULT 'scheduled'
    CHECK (source IN ('scheduled', 'manual')),
  priority int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'leased', 'done', 'failed', 'canceled')),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT scout_dispatch_queue_lease_check CHECK (
    (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'leased'
  )
);

CREATE UNIQUE INDEX scout_dispatch_queue_one_active_per_scout
  ON public.scout_dispatch_queue(scout_id)
  WHERE status IN ('queued', 'leased');

CREATE INDEX scout_dispatch_queue_claim_order
  ON public.scout_dispatch_queue(priority DESC, scheduled_for, created_at)
  WHERE status = 'queued';

CREATE INDEX scout_dispatch_queue_active_leases
  ON public.scout_dispatch_queue(lease_expires_at)
  WHERE status = 'leased';

ALTER TABLE public.scout_dispatch_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scout_dispatch_queue FROM anon, authenticated;

ALTER TABLE public.scout_runs DROP CONSTRAINT IF EXISTS scout_runs_stage_check;
ALTER TABLE public.scout_runs
  ADD CONSTRAINT scout_runs_stage_check CHECK (
    stage IS NULL OR stage IN (
      'queued',
      'dispatch',
      'scrape',
      'diff',
      'extract',
      'dedup',
      'insert_units',
      'notify',
      'credits',
      'finalize'
    )
  );

CREATE OR REPLACE FUNCTION public.enqueue_scout_dispatch(
  p_scout_id uuid,
  p_run_id uuid DEFAULT NULL,
  p_source text DEFAULT 'scheduled',
  p_priority int DEFAULT 0
)
RETURNS TABLE (run_id uuid, enqueued boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_scout public.scouts%ROWTYPE;
  v_existing_run_id uuid;
  v_run_id uuid := p_run_id;
  v_source text := lower(COALESCE(p_source, 'scheduled'));
BEGIN
  IF v_source NOT IN ('scheduled', 'manual') THEN
    RAISE EXCEPTION 'invalid dispatch source: %', p_source;
  END IF;

  SELECT * INTO v_scout
    FROM public.scouts
   WHERE id = p_scout_id
     AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'scout is paused or not found';
  END IF;
  IF v_scout.type NOT IN ('web', 'beat', 'civic') THEN
    RAISE EXCEPTION 'scout type % is not queue-backed', v_scout.type;
  END IF;

  -- Serialize enqueue decisions for one scout. The partial unique index is a
  -- second line of defence, but this lock lets us return the existing run.
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
         SET status = 'skipped',
             stage = 'finalize',
             error_message = 'a run for this scout is already queued or executing',
             completed_at = now()
       WHERE id = v_run_id
         AND scout_id = p_scout_id
         AND status = 'running';
    END IF;
    RETURN QUERY SELECT v_existing_run_id, false;
    RETURN;
  END IF;

  IF v_run_id IS NULL THEN
    INSERT INTO public.scout_runs (
      scout_id, user_id, status, stage, started_at, metadata
    ) VALUES (
      p_scout_id,
      v_scout.user_id,
      'running',
      'queued',
      now(),
      jsonb_build_object('dispatch_source', v_source)
    )
    RETURNING id INTO v_run_id;
  ELSE
    IF NOT EXISTS (
      SELECT 1
        FROM public.scout_runs r
       WHERE r.id = v_run_id
         AND r.scout_id = p_scout_id
         AND r.user_id = v_scout.user_id
         AND r.status = 'running'
    ) THEN
      RAISE EXCEPTION 'run is missing, terminal, or does not belong to scout';
    END IF;

    UPDATE public.scout_runs
       SET stage = 'queued',
           metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('dispatch_source', v_source)
     WHERE id = v_run_id;
  END IF;

  INSERT INTO public.scout_dispatch_queue (
    scout_run_id,
    scout_id,
    user_id,
    scout_type,
    source,
    priority
  ) VALUES (
    v_run_id,
    p_scout_id,
    v_scout.user_id,
    v_scout.type,
    v_source,
    LEAST(1000, GREATEST(-1000, COALESCE(p_priority, 0)))
  );

  RETURN QUERY SELECT v_run_id, true;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_scout_dispatch_batch(
  p_worker_id text,
  p_capacity int DEFAULT 3,
  p_limit int DEFAULT 3,
  p_lease_seconds int DEFAULT 900,
  p_max_attempts int DEFAULT 3
)
RETURNS TABLE (
  queue_id uuid,
  run_id uuid,
  scout_id uuid,
  user_id uuid,
  scout_type text,
  source text,
  attempt int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_capacity int := LEAST(20, GREATEST(1, COALESCE(p_capacity, 3)));
  v_limit int := LEAST(20, GREATEST(1, COALESCE(p_limit, 3)));
  v_lease_seconds int := LEAST(3600, GREATEST(60, COALESCE(p_lease_seconds, 900)));
  v_max_attempts int := LEAST(10, GREATEST(1, COALESCE(p_max_attempts, 3)));
  v_active int;
  v_available int;
BEGIN
  IF length(trim(COALESCE(p_worker_id, ''))) = 0 THEN
    RAISE EXCEPTION 'worker id is required';
  END IF;

  -- Every claimant takes the same transaction lock, making capacity accounting
  -- exact even when several pg_cron HTTP requests overlap.
  PERFORM pg_advisory_xact_lock(hashtextextended('scout_dispatch_capacity', 0));

  -- Reflect worker-owned terminal run states before counting occupied slots.
  UPDATE public.scout_dispatch_queue q
     SET status = CASE WHEN r.status = 'error' THEN 'failed' ELSE 'done' END,
         lease_owner = NULL,
         lease_expires_at = NULL,
         completed_at = COALESCE(q.completed_at, now()),
         updated_at = now()
    FROM public.scout_runs r
   WHERE q.scout_run_id = r.id
     AND q.status IN ('queued', 'leased')
     AND r.status IN ('success', 'error', 'skipped');

  -- A lost worker gets a bounded retry. Exhausted leases terminalize the same
  -- run instead of manufacturing new attempt rows.
  UPDATE public.scout_dispatch_queue
     SET status = 'queued',
         scheduled_for = now(),
         lease_owner = NULL,
         lease_expires_at = NULL,
         last_error_code = 'dispatch_lease_expired',
         last_error_message = 'dispatch lease expired before the run reached a terminal state',
         updated_at = now()
   WHERE status = 'leased'
     AND lease_expires_at <= now()
     AND attempts < v_max_attempts;

  WITH exhausted AS (
    UPDATE public.scout_dispatch_queue
       SET status = 'failed',
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error_code = 'dispatch_attempts_exhausted',
           last_error_message = 'dispatch lease expired after the maximum number of attempts',
           completed_at = now(),
           updated_at = now()
     WHERE status = 'leased'
       AND lease_expires_at <= now()
       AND attempts >= v_max_attempts
     RETURNING scout_run_id
  )
  UPDATE public.scout_runs r
     SET status = 'error',
         stage = 'finalize',
         error_class = 'timeout',
         error_message = 'dispatch lease expired after the maximum number of attempts',
         completed_at = now()
    FROM exhausted e
   WHERE r.id = e.scout_run_id
     AND r.status = 'running';

  SELECT count(*)::int INTO v_active
    FROM public.scout_dispatch_queue q
    JOIN public.scout_runs r ON r.id = q.scout_run_id
   WHERE q.status = 'leased'
     AND q.lease_expires_at > now()
     AND r.status = 'running';

  v_available := GREATEST(0, v_capacity - v_active);
  IF v_available = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT q.id
      FROM public.scout_dispatch_queue q
      JOIN public.scout_runs r ON r.id = q.scout_run_id
     WHERE q.status = 'queued'
       AND q.scheduled_for <= now()
       AND r.status = 'running'
     ORDER BY q.priority DESC, q.scheduled_for, q.created_at
     FOR UPDATE OF q SKIP LOCKED
     LIMIT LEAST(v_limit, v_available)
  ), claimed AS (
    UPDATE public.scout_dispatch_queue q
       SET status = 'leased',
           attempts = q.attempts + 1,
           lease_owner = p_worker_id,
           lease_expires_at = now() + make_interval(secs => v_lease_seconds),
           last_error_code = NULL,
           last_error_message = NULL,
           updated_at = now()
      FROM candidates c
     WHERE q.id = c.id
     RETURNING q.*
  )
  SELECT
    c.id,
    c.scout_run_id,
    c.scout_id,
    c.user_id,
    c.scout_type,
    c.source,
    c.attempts
  FROM claimed c
  ORDER BY c.priority DESC, c.scheduled_for, c.created_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_scout_dispatch(
  p_queue_id uuid,
  p_worker_id text,
  p_success boolean,
  p_error_code text DEFAULT NULL,
  p_error_message text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id uuid;
  v_run_status text;
BEGIN
  SELECT q.scout_run_id, r.status
    INTO v_run_id, v_run_status
    FROM public.scout_dispatch_queue q
    JOIN public.scout_runs r ON r.id = q.scout_run_id
   WHERE q.id = p_queue_id
     AND q.status = 'leased'
     AND q.lease_owner = p_worker_id
   FOR UPDATE OF q;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF p_success OR v_run_status IN ('success', 'skipped') THEN
    UPDATE public.scout_dispatch_queue
       SET status = 'done',
           lease_owner = NULL,
           lease_expires_at = NULL,
           completed_at = now(),
           updated_at = now()
     WHERE id = p_queue_id;
  ELSE
    UPDATE public.scout_dispatch_queue
       SET status = 'failed',
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error_code = COALESCE(p_error_code, 'dispatch_failed'),
           last_error_message = left(COALESCE(p_error_message, 'worker dispatch failed'), 2000),
           completed_at = now(),
           updated_at = now()
     WHERE id = p_queue_id;

    UPDATE public.scout_runs
       SET status = 'error',
           stage = 'finalize',
           error_class = 'platform',
           error_message = left(COALESCE(p_error_message, 'worker dispatch failed'), 2000),
           completed_at = now()
     WHERE id = v_run_id
       AND status = 'running';
  END IF;

  RETURN true;
END;
$$;

-- Queue wait must not look like a stale executing run. Lease expiry is owned by
-- claim_scout_dispatch_batch; the legacy reconcilers still cover unqueued work.
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
          AND q.status IN ('queued', 'leased')
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
            AND q.status IN ('queued', 'leased')
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

CREATE OR REPLACE FUNCTION public.trigger_scout_run(
  p_scout_id uuid,
  p_user_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id uuid;
  v_project_url text;
  v_internal_key text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.scouts
     WHERE id = p_scout_id
       AND user_id = p_user_id
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'scout is paused or not found';
  END IF;

  SELECT decrypted_secret INTO v_project_url
    FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_internal_key
    FROM vault.decrypted_secrets WHERE name = 'internal_service_key';

  IF v_project_url IS NULL OR v_internal_key IS NULL THEN
    RAISE EXCEPTION 'vault secrets project_url / internal_service_key must be set before triggering scouts';
  END IF;

  INSERT INTO public.scout_runs (scout_id, user_id, status, started_at)
  VALUES (p_scout_id, p_user_id, 'running', now())
  RETURNING id INTO v_run_id;

  PERFORM net.http_post(
    url := v_project_url || '/functions/v1/execute-scout',
    headers := jsonb_build_object(
      'X-Service-Key', v_internal_key,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'scout_id', p_scout_id::text,
      'run_id', v_run_id::text,
      'user_id', p_user_id::text,
      'trigger_source', 'manual'
    )
  );

  RETURN v_run_id;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_scout_dispatch(uuid, uuid, text, int)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_scout_dispatch_batch(text, int, int, int, int)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_scout_dispatch(uuid, text, boolean, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.enqueue_scout_dispatch(uuid, uuid, text, int)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_scout_dispatch_batch(text, int, int, int, int)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_scout_dispatch(uuid, text, boolean, text, text)
  TO service_role;

DO $$
BEGIN
  PERFORM cron.unschedule('drain-scout-dispatch')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-scout-dispatch');

  PERFORM cron.schedule(
    'drain-scout-dispatch',
    '* * * * *',
    $cmd$
      SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/scout-dispatch-drain',
        headers := jsonb_build_object(
          'X-Service-Key', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_service_key'),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb
      )
      WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
        AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key');
    $cmd$
  );
END;
$$;
