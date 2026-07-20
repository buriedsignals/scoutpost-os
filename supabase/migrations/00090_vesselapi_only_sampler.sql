-- Remove the obsolete WebSocket sampling-window interface now that VesselAPI
-- is Scoutpost's only vessel-position provider. The persisted task value stays
-- `ais` because it describes maritime AIS data, not the retired vendor.

BEGIN;

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
        'Content-Type',  'application/json'
      ),
      body := '{"task":"gp"}'::jsonb
    )
    WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
      AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key');
  $cmd$
);

DROP FUNCTION IF EXISTS public.trigger_transport_sampler(text, integer);

CREATE OR REPLACE FUNCTION public.trigger_transport_sampler(
  p_task text DEFAULT 'ais'
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
    body := jsonb_build_object('task', p_task)
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_transport_sampler(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_transport_sampler(text)
  TO service_role;

COMMIT;
