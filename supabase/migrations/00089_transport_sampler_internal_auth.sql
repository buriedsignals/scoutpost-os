-- Route the transport sampler cron through the internal service boundary.
-- The former service-role bearer path can diverge from the Edge Runtime's
-- current service-role secret after key rotation. Internal cron calls already
-- use the dedicated Vault secret everywhere else.

BEGIN;

SELECT cron.unschedule('transport-ais-sampler')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'transport-ais-sampler');

SELECT cron.schedule(
  'transport-ais-sampler',
  '7 * * * *',
  $cmd$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/transport-sampler',
      headers := jsonb_build_object(
        'X-Service-Key', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_service_key'),
        'Content-Type',  'application/json'
      ),
      body := '{"task":"ais"}'::jsonb
    )
    WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
      AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key');
  $cmd$
);

-- Service-role-only operator hook for immediate canaries. It never returns or
-- logs either Vault secret; it returns pg_net's request identifier only.
CREATE OR REPLACE FUNCTION public.trigger_transport_sampler(
  p_task text DEFAULT 'ais',
  p_window_ms integer DEFAULT NULL
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
  IF p_window_ms IS NOT NULL AND (p_task <> 'ais' OR p_window_ms < 10000 OR p_window_ms > 180000) THEN
    RAISE EXCEPTION 'invalid transport sampler window';
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
    body := jsonb_strip_nulls(jsonb_build_object(
      'task', p_task,
      'window_ms', p_window_ms
    ))
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_transport_sampler(text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_transport_sampler(text, integer)
  TO service_role;

COMMIT;
