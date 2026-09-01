-- CelesTrak provider safety: disabled-by-default approval gate, durable halt,
-- deployment-wide refresh lease, and atomic GP catalog generations.

BEGIN;

ALTER TABLE public.operator_incidents
  DROP CONSTRAINT operator_incidents_kind_check;
ALTER TABLE public.operator_incidents
  ADD CONSTRAINT operator_incidents_kind_check CHECK (kind IN (
    'dispatch_queue_delay',
    'civic_queue_delay',
    'vessel_sampler_health',
    'crawler_workflow_health',
    'celestrak_gp_provider_health'
  ));

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
  IF p_kind NOT IN (
    'dispatch_queue_delay',
    'civic_queue_delay',
    'vessel_sampler_health',
    'crawler_workflow_health',
    'celestrak_gp_provider_health'
  ) THEN
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
      notification_pending, resolved_at, updated_at
    ) VALUES (
      p_incident_key, p_kind, 'active', p_severity,
      left(p_summary, 1000), COALESCE(p_details, '{}'::jsonb),
      v_now, v_now, NULL, should_notify, NULL, v_now
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

CREATE TABLE public.transport_gp_refresh_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  approved_by text,
  approved_at timestamptz,
  current_generation_id uuid,
  current_generation_fetched_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_http_status integer,
  last_error_body text,
  halted_at timestamptz,
  halt_reason text,
  lease_token uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK (NOT enabled OR approved_at IS NOT NULL),
  CHECK (length(COALESCE(last_error_body, '')) <= 2000)
);

INSERT INTO public.transport_gp_refresh_control (singleton, enabled)
VALUES (true, false);

ALTER TABLE public.transport_gp_refresh_control ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.transport_gp_refresh_control FROM anon, authenticated;

CREATE TABLE public.transport_gp_catalog (
  generation_id uuid NOT NULL,
  norad_id integer NOT NULL,
  name text,
  omm jsonb NOT NULL,
  epoch timestamptz,
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (generation_id, norad_id)
);

CREATE INDEX transport_gp_catalog_norad
  ON public.transport_gp_catalog (norad_id, generation_id);
CREATE INDEX transport_gp_catalog_generation_fetched
  ON public.transport_gp_catalog (generation_id, fetched_at DESC);

ALTER TABLE public.transport_gp_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.transport_gp_catalog FROM anon, authenticated;

-- Preserve the last legacy cache as one complete generation. Provider access
-- remains disabled until an operator records explicit approval.
DO $$
DECLARE
  v_generation uuid;
  v_fetched_at timestamptz;
BEGIN
  SELECT max(fetched_at) INTO v_fetched_at
    FROM public.transport_gp_cache;
  IF v_fetched_at IS NOT NULL THEN
    v_generation := gen_random_uuid();
    INSERT INTO public.transport_gp_catalog (
      generation_id, norad_id, name, omm, epoch, fetched_at
    )
    SELECT v_generation, norad_id, name, omm, epoch, fetched_at
      FROM public.transport_gp_cache;
    UPDATE public.transport_gp_refresh_control
       SET current_generation_id = v_generation,
           current_generation_fetched_at = v_fetched_at,
           last_success_at = v_fetched_at,
           updated_at = now()
     WHERE singleton;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_transport_gp_refresh_enabled(
  p_enabled boolean,
  p_approved_by text DEFAULT NULL,
  p_clear_halt boolean DEFAULT false
)
RETURNS public.transport_gp_refresh_control
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.transport_gp_refresh_control%ROWTYPE;
BEGIN
  IF p_enabled AND length(trim(COALESCE(p_approved_by, ''))) = 0 THEN
    RAISE EXCEPTION 'approved_by is required to enable CelesTrak refresh';
  END IF;

  UPDATE public.transport_gp_refresh_control
     SET enabled = p_enabled,
         approved_by = CASE
           WHEN p_enabled THEN left(trim(p_approved_by), 200)
           ELSE approved_by
         END,
         approved_at = CASE WHEN p_enabled THEN now() ELSE approved_at END,
         halted_at = CASE WHEN p_clear_halt THEN NULL ELSE halted_at END,
         halt_reason = CASE WHEN p_clear_halt THEN NULL ELSE halt_reason END,
         last_http_status = CASE WHEN p_clear_halt THEN NULL ELSE last_http_status END,
         last_error_body = CASE WHEN p_clear_halt THEN NULL ELSE last_error_body END,
         lease_token = CASE WHEN p_enabled THEN lease_token ELSE NULL END,
         lease_expires_at = CASE WHEN p_enabled THEN lease_expires_at ELSE NULL END,
         updated_at = now()
   WHERE singleton
   RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.acquire_transport_gp_refresh_lease(
  p_lease_token uuid,
  p_lease_seconds integer DEFAULT 120
)
RETURNS TABLE (
  acquired boolean,
  reason text,
  current_generation_id uuid,
  current_generation_fetched_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state public.transport_gp_refresh_control%ROWTYPE;
  v_lease_seconds integer := LEAST(300, GREATEST(60, COALESCE(p_lease_seconds, 120)));
BEGIN
  IF p_lease_token IS NULL THEN
    RAISE EXCEPTION 'lease token is required';
  END IF;

  SELECT * INTO v_state
    FROM public.transport_gp_refresh_control
   WHERE singleton
   FOR UPDATE;

  IF NOT v_state.enabled THEN
    RETURN QUERY SELECT false, 'disabled'::text,
      v_state.current_generation_id, v_state.current_generation_fetched_at;
    RETURN;
  END IF;
  IF v_state.halted_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'halted'::text,
      v_state.current_generation_id, v_state.current_generation_fetched_at;
    RETURN;
  END IF;
  IF v_state.last_success_at IS NOT NULL
     AND v_state.last_success_at > now() - interval '2 hours' THEN
    RETURN QUERY SELECT false, 'not_due'::text,
      v_state.current_generation_id, v_state.current_generation_fetched_at;
    RETURN;
  END IF;
  IF v_state.lease_token IS NOT NULL
     AND v_state.lease_expires_at > now() THEN
    RETURN QUERY SELECT false, 'busy'::text,
      v_state.current_generation_id, v_state.current_generation_fetched_at;
    RETURN;
  END IF;

  UPDATE public.transport_gp_refresh_control
     SET lease_token = p_lease_token,
         lease_expires_at = now() + make_interval(secs => v_lease_seconds),
         last_attempt_at = now(),
         updated_at = now()
   WHERE singleton;

  RETURN QUERY SELECT true, 'acquired'::text,
    v_state.current_generation_id, v_state.current_generation_fetched_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_transport_gp_refresh(
  p_lease_token uuid,
  p_generation_id uuid,
  p_fetched_at timestamptz,
  p_http_status integer DEFAULT 200
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  SELECT count(*)::integer INTO v_rows
    FROM public.transport_gp_catalog
   WHERE generation_id = p_generation_id;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'GP generation is empty';
  END IF;

  UPDATE public.transport_gp_refresh_control
     SET current_generation_id = p_generation_id,
         current_generation_fetched_at = p_fetched_at,
         last_success_at = now(),
         last_http_status = p_http_status,
         last_error_body = NULL,
         halted_at = NULL,
         halt_reason = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = now()
   WHERE singleton
     AND lease_token = p_lease_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GP refresh lease lost';
  END IF;

  DELETE FROM public.transport_gp_catalog
   WHERE generation_id <> p_generation_id;
  RETURN v_rows;
END;
$$;

CREATE OR REPLACE FUNCTION public.halt_transport_gp_refresh(
  p_lease_token uuid,
  p_reason text,
  p_http_status integer DEFAULT NULL,
  p_error_body text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.transport_gp_refresh_control
     SET halted_at = now(),
         halt_reason = left(COALESCE(NULLIF(trim(p_reason), ''), 'provider_error'), 200),
         last_http_status = p_http_status,
         last_error_body = left(NULLIF(p_error_body, ''), 2000),
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = now()
   WHERE singleton
     AND lease_token = p_lease_token;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.set_transport_gp_refresh_enabled(boolean, text, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.acquire_transport_gp_refresh_lease(uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_transport_gp_refresh(uuid, uuid, timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.halt_transport_gp_refresh(uuid, text, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_transport_gp_refresh_enabled(boolean, text, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.acquire_transport_gp_refresh_lease(uuid, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_transport_gp_refresh(uuid, uuid, timestamptz, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.halt_transport_gp_refresh(uuid, text, integer, text)
  TO service_role;

-- Replace the legacy cleanup dependency before dropping the mutable cache.
CREATE OR REPLACE FUNCTION public.cleanup_transport_data()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM transport_positions WHERE mmsi IN (
    SELECT mmsi FROM transport_positions
    WHERE seen_at < now() - interval '24 hours'
    LIMIT 50000
  );
  DELETE FROM transport_scout_state WHERE (scout_id, object_id) IN (
    SELECT scout_id, object_id FROM transport_scout_state
    WHERE object_id LIKE 'pass:%'
      AND last_seen < now() - interval '30 days'
    LIMIT 50000
  );
  DELETE FROM transport_gp_catalog WHERE (generation_id, norad_id) IN (
    SELECT c.generation_id, c.norad_id
      FROM transport_gp_catalog c
      CROSS JOIN transport_gp_refresh_control s
     WHERE c.generation_id <> s.current_generation_id
       AND c.fetched_at < now() - interval '1 day'
     LIMIT 50000
  );
END;
$$;

DROP TABLE public.transport_gp_cache;

DROP FUNCTION IF EXISTS public.trigger_transport_sampler(text);

CREATE FUNCTION public.trigger_transport_sampler(
  p_task text DEFAULT 'ais',
  p_operator_bootstrap boolean DEFAULT false
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project_url text;
  v_internal_key text;
  v_request_id bigint;
BEGIN
  IF p_task NOT IN ('ais', 'gp') THEN
    RAISE EXCEPTION 'invalid transport sampler task';
  END IF;
  IF p_operator_bootstrap AND p_task <> 'gp' THEN
    RAISE EXCEPTION 'operator bootstrap is only valid for GP refresh';
  END IF;

  SELECT decrypted_secret INTO v_project_url
    FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_internal_key
    FROM vault.decrypted_secrets WHERE name = 'internal_service_key';
  IF v_project_url IS NULL OR v_internal_key IS NULL THEN
    RAISE EXCEPTION 'transport sampler Vault secrets are not configured';
  END IF;

  SELECT net.http_post(
    url := v_project_url || '/functions/v1/transport-sampler',
    headers := jsonb_build_object(
      'X-Service-Key', v_internal_key,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'task', p_task,
      'operator_bootstrap', p_operator_bootstrap
    )
  ) INTO v_request_id;
  RETURN v_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_transport_sampler(text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_transport_sampler(text, boolean)
  TO service_role;

-- Keep the system cron installed but provider-safe. A fresh install or upgrade
-- performs no Edge invocation until an operator records approval, and a halt
-- blocks future invocations before pg_net allocates a request.
SELECT cron.unschedule('transport-gp-refresh')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'transport-gp-refresh');
SELECT cron.schedule(
  'transport-gp-refresh',
  '17 5 * * *',
  $cmd$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/transport-sampler',
      headers := jsonb_build_object(
        'X-Service-Key', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_service_key'),
        'Content-Type', 'application/json'
      ),
      body := '{"task":"gp"}'::jsonb
    )
    WHERE EXISTS (
      SELECT 1 FROM public.transport_gp_refresh_control
       WHERE singleton
         AND enabled
         AND halted_at IS NULL
         AND (lease_expires_at IS NULL OR lease_expires_at <= now())
         AND (last_success_at IS NULL OR last_success_at <= now() - interval '2 hours')
    )
      AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
      AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key');
  $cmd$
);

COMMIT;
