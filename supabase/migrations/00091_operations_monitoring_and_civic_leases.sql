-- Durable operational incidents plus explicit Civic worker leases.

BEGIN;

CREATE TABLE public.operator_incidents (
  incident_key text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN (
    'dispatch_queue_delay',
    'civic_queue_delay',
    'vessel_sampler_health'
  )),
  status text NOT NULL CHECK (status IN ('active', 'resolved')),
  severity text NOT NULL CHECK (severity IN ('warning', 'critical')),
  summary text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz,
  notification_pending boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX operator_incidents_active
  ON public.operator_incidents(last_observed_at DESC)
  WHERE status = 'active';

ALTER TABLE public.operator_incidents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.operator_incidents FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_operator_incident(
  p_incident_key text,
  p_kind text,
  p_active boolean,
  p_severity text,
  p_summary text,
  p_details jsonb DEFAULT '{}'::jsonb,
  p_repeat_seconds int DEFAULT 21600
)
RETURNS TABLE (should_notify boolean, transition text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.operator_incidents%ROWTYPE;
  v_now timestamptz := now();
  v_repeat int := LEAST(86400, GREATEST(300, COALESCE(p_repeat_seconds, 21600)));
BEGIN
  IF length(trim(COALESCE(p_incident_key, ''))) = 0 THEN
    RAISE EXCEPTION 'incident key is required';
  END IF;
  IF p_kind NOT IN ('dispatch_queue_delay', 'civic_queue_delay', 'vessel_sampler_health') THEN
    RAISE EXCEPTION 'invalid incident kind';
  END IF;
  IF p_severity NOT IN ('warning', 'critical') THEN
    RAISE EXCEPTION 'invalid incident severity';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('operator:' || p_incident_key, 0));
  SELECT * INTO v_existing
    FROM public.operator_incidents
   WHERE incident_key = p_incident_key
   FOR UPDATE;

  IF p_active THEN
    should_notify := NOT FOUND
      OR v_existing.status = 'resolved'
      OR v_existing.notification_pending
      OR v_existing.last_notified_at IS NULL
      OR v_existing.last_notified_at <= v_now - make_interval(secs => v_repeat);
    transition := CASE
      WHEN NOT FOUND OR v_existing.status = 'resolved' THEN 'opened'
      WHEN should_notify THEN 'reminder'
      ELSE 'unchanged'
    END;

    INSERT INTO public.operator_incidents (
      incident_key, kind, status, severity, summary, details,
      first_observed_at, last_observed_at, last_notified_at,
      notification_pending,
      resolved_at, updated_at
    ) VALUES (
      p_incident_key, p_kind, 'active', p_severity,
      left(p_summary, 1000), COALESCE(p_details, '{}'::jsonb),
      v_now, v_now, NULL,
      should_notify,
      NULL, v_now
    )
    ON CONFLICT (incident_key) DO UPDATE
      SET kind = EXCLUDED.kind,
          status = 'active',
          severity = EXCLUDED.severity,
          summary = EXCLUDED.summary,
          details = EXCLUDED.details,
          first_observed_at = CASE
            WHEN public.operator_incidents.status = 'resolved' THEN v_now
            ELSE public.operator_incidents.first_observed_at
          END,
          last_observed_at = v_now,
          notification_pending = public.operator_incidents.notification_pending
            OR should_notify,
          resolved_at = NULL,
          updated_at = v_now;
    RETURN NEXT;
    RETURN;
  END IF;

  IF NOT FOUND THEN
    should_notify := false;
    transition := 'unchanged';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_existing.status = 'resolved' THEN
    should_notify := v_existing.notification_pending;
    transition := CASE WHEN should_notify THEN 'resolved' ELSE 'unchanged' END;
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE public.operator_incidents
     SET status = 'resolved',
         summary = left(p_summary, 1000),
         details = COALESCE(p_details, '{}'::jsonb),
         last_observed_at = v_now,
         notification_pending = true,
         resolved_at = v_now,
         updated_at = v_now
   WHERE incident_key = p_incident_key;
  should_notify := true;
  transition := 'resolved';
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.ack_operator_incident_notifications(
  p_incident_keys text[]
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE public.operator_incidents
     SET notification_pending = false,
         last_notified_at = now(),
         updated_at = now()
   WHERE incident_key = ANY(COALESCE(p_incident_keys, ARRAY[]::text[]))
     AND notification_pending = true;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

ALTER TABLE public.civic_extraction_queue
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN completed_at timestamptz;

-- Legacy processing rows predate ownership. Return them to the queue before
-- enforcing the lease invariant.
UPDATE public.civic_extraction_queue
   SET status = 'pending',
       lease_owner = NULL,
       lease_expires_at = NULL,
       heartbeat_at = NULL,
       updated_at = now()
 WHERE status = 'processing';

ALTER TABLE public.civic_extraction_queue
  ADD CONSTRAINT civic_extraction_queue_lease_check CHECK (
    (
      status = 'processing'
      AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND heartbeat_at IS NOT NULL
    )
    OR (
      status <> 'processing'
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND heartbeat_at IS NULL
    )
  );

CREATE INDEX civic_extraction_queue_active_leases
  ON public.civic_extraction_queue(lease_expires_at)
  WHERE status = 'processing';

DROP FUNCTION IF EXISTS public.claim_civic_queue_item(uuid);
DROP FUNCTION IF EXISTS public.civic_queue_failsafe();

CREATE FUNCTION public.civic_queue_failsafe(
  p_max_attempts int DEFAULT 3
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max int := LEAST(10, GREATEST(1, COALESCE(p_max_attempts, 3)));
  v_count int;
  v_failed_run_ids uuid[];
BEGIN
  WITH expired AS (
    UPDATE public.civic_extraction_queue
       SET status = CASE WHEN attempts >= v_max THEN 'failed' ELSE 'pending' END,
           last_error = CASE
             WHEN attempts >= v_max THEN 'civic lease expired after maximum attempts'
             ELSE 'civic worker lease expired and was reclaimed'
           END,
           lease_owner = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           completed_at = CASE WHEN attempts >= v_max THEN now() ELSE NULL END,
           updated_at = now()
     WHERE status = 'processing'
       AND lease_expires_at <= now()
    RETURNING scout_run_id, status
  )
  SELECT count(*)::int,
         array_agg(scout_run_id) FILTER (
           WHERE status = 'failed' AND scout_run_id IS NOT NULL
         )
    INTO v_count, v_failed_run_ids
    FROM expired;

  UPDATE public.scout_runs r
     SET status = 'error',
         stage = 'finalize',
         error_class = 'timeout',
         error_message = 'civic worker lease expired after maximum attempts',
         notification_status = 'not_applicable',
         completed_at = now()
   WHERE v_failed_run_ids IS NOT NULL
     AND r.id = ANY(v_failed_run_ids)
     AND r.status = 'running'
     AND NOT EXISTS (
       SELECT 1
         FROM public.civic_extraction_queue q
        WHERE q.scout_run_id = r.id
          AND q.status IN ('pending', 'processing')
     );
  RETURN v_count;
END;
$$;

CREATE FUNCTION public.claim_civic_queue_item(
  p_worker_id text,
  p_scout_run_id uuid DEFAULT NULL,
  p_lease_seconds int DEFAULT 900,
  p_max_attempts int DEFAULT 3
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  scout_id uuid,
  scout_run_id uuid,
  source_url text,
  doc_kind text,
  attempts int,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed_id uuid;
  v_lease int := LEAST(3600, GREATEST(60, COALESCE(p_lease_seconds, 900)));
  v_max int := LEAST(10, GREATEST(1, COALESCE(p_max_attempts, 3)));
BEGIN
  IF length(trim(COALESCE(p_worker_id, ''))) = 0 THEN
    RAISE EXCEPTION 'worker id is required';
  END IF;

  PERFORM public.civic_queue_failsafe(v_max);

  WITH candidate AS (
    SELECT q.id
      FROM public.civic_extraction_queue q
     WHERE q.status = 'pending'
       AND q.attempts < v_max
       AND (p_scout_run_id IS NULL OR q.scout_run_id = p_scout_run_id)
     ORDER BY q.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  UPDATE public.civic_extraction_queue q
     SET status = 'processing',
         attempts = q.attempts + 1,
         lease_owner = p_worker_id,
         lease_expires_at = now() + make_interval(secs => v_lease),
         heartbeat_at = now(),
         last_error = NULL,
         completed_at = NULL,
         updated_at = now()
    FROM candidate
   WHERE q.id = candidate.id
  RETURNING q.id INTO v_claimed_id;

  IF v_claimed_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT q.id, q.user_id, q.scout_id, q.scout_run_id, q.source_url,
         q.doc_kind, q.attempts, q.lease_owner, q.lease_expires_at,
         q.heartbeat_at
    FROM public.civic_extraction_queue q
   WHERE q.id = v_claimed_id;
END;
$$;

CREATE FUNCTION public.heartbeat_civic_queue_item(
  p_queue_id uuid,
  p_worker_id text,
  p_lease_seconds int DEFAULT 900
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows int;
  v_lease int := LEAST(3600, GREATEST(60, COALESCE(p_lease_seconds, 900)));
BEGIN
  UPDATE public.civic_extraction_queue
     SET heartbeat_at = now(),
         lease_expires_at = now() + make_interval(secs => v_lease),
         updated_at = now()
   WHERE id = p_queue_id
     AND status = 'processing'
     AND lease_owner = p_worker_id
     AND lease_expires_at > now();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

CREATE FUNCTION public.fail_civic_queue_item(
  p_queue_id uuid,
  p_worker_id text,
  p_error text,
  p_max_attempts int DEFAULT 3
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempts int;
  v_status text;
  v_max int := LEAST(10, GREATEST(1, COALESCE(p_max_attempts, 3)));
BEGIN
  SELECT attempts INTO v_attempts
    FROM public.civic_extraction_queue
   WHERE id = p_queue_id
     AND status = 'processing'
     AND lease_owner = p_worker_id
     AND lease_expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'lease_lost';
  END IF;

  v_status := CASE WHEN v_attempts >= v_max THEN 'failed' ELSE 'pending' END;
  UPDATE public.civic_extraction_queue
     SET status = v_status,
         last_error = left(COALESCE(p_error, 'civic worker failed'), 2000),
         lease_owner = NULL,
         lease_expires_at = NULL,
         heartbeat_at = NULL,
         completed_at = CASE WHEN v_status = 'failed' THEN now() ELSE NULL END,
         updated_at = now()
   WHERE id = p_queue_id;
  RETURN v_status;
END;
$$;

DROP FUNCTION IF EXISTS public.finalize_civic_run_doc(uuid, uuid, int, int, uuid);
CREATE FUNCTION public.finalize_civic_run_doc(
  p_queue_id uuid,
  p_worker_id text,
  p_run_id uuid,
  p_created int,
  p_merged int,
  p_raw_capture_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows int;
BEGIN
  UPDATE public.civic_extraction_queue
     SET status = 'done',
         raw_capture_id = COALESCE(p_raw_capture_id, raw_capture_id),
         lease_owner = NULL,
         lease_expires_at = NULL,
         heartbeat_at = NULL,
         completed_at = now(),
         updated_at = now()
   WHERE id = p_queue_id
     AND status = 'processing'
     AND lease_owner = p_worker_id
     AND lease_expires_at > now();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN false;
  END IF;

  IF p_run_id IS NOT NULL THEN
    UPDATE public.scout_runs
       SET status = 'success',
           stage = 'finalize',
           error_class = NULL,
           error_message = NULL,
           scraper_status = true,
           units_created_count = COALESCE(units_created_count, 0) + p_created,
           units_merged_count = COALESCE(units_merged_count, 0) + p_merged,
           articles_count = COALESCE(articles_count, 0) + p_created,
           merged_existing_count = COALESCE(merged_existing_count, 0) + p_merged,
           criteria_status = COALESCE(criteria_status, false) OR (p_created > 0),
           notification_status = CASE
             WHEN p_created > 0
               AND COALESCE(notification_status, '') NOT IN (
                 'sent', 'delivered', 'delayed', 'bounced', 'suppressed',
                 'complained', 'failed'
               ) THEN 'pending'
             WHEN COALESCE(notification_status, '') = '' THEN 'skipped'
             ELSE notification_status
           END,
           completed_at = now()
     WHERE id = p_run_id;
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.record_operator_incident(text, text, boolean, text, text, jsonb, int)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ack_operator_incident_notifications(text[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.civic_queue_failsafe(int)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_civic_queue_item(text, uuid, int, int)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_civic_queue_item(uuid, text, int)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_civic_queue_item(uuid, text, text, int)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_civic_run_doc(uuid, text, uuid, int, int, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_operator_incident(text, text, boolean, text, text, jsonb, int)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ack_operator_incident_notifications(text[])
  TO service_role;
GRANT EXECUTE ON FUNCTION public.civic_queue_failsafe(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_civic_queue_item(text, uuid, int, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_civic_queue_item(uuid, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_civic_queue_item(uuid, text, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_civic_run_doc(uuid, text, uuid, int, int, uuid)
  TO service_role;

DO $$
BEGIN
  PERFORM cron.unschedule('operations-monitor')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'operations-monitor');
  PERFORM cron.schedule(
    'operations-monitor',
    '*/5 * * * *',
    $cmd$
      SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/operations-monitor',
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

COMMIT;
