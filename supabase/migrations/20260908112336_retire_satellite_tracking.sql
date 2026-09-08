-- Retire satellite tracking without deleting scouts or their run/feed history.
BEGIN;

SELECT cron.unschedule('transport-gp-refresh')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'transport-gp-refresh');

DO $$
DECLARE s record;
BEGIN
  FOR s IN SELECT id FROM public.scouts
    WHERE type = 'transport' AND config->>'mode' = 'satellite'
  LOOP
    PERFORM public.unschedule_scout(s.id);
  END LOOP;
END;
$$;

UPDATE public.scouts
SET is_active = false, schedule_cron = NULL, updated_at = now()
WHERE type = 'transport' AND config->>'mode' = 'satellite';

-- Old clients and direct Data API writes cannot restore the retired mode.
-- Inactive historical rows remain editable/deletable.
CREATE FUNCTION public.reject_retired_satellite_scout()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.type = 'transport' AND NEW.config->>'mode' = 'satellite' THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'satellite tracking is retired' USING ERRCODE = '23514';
    ELSIF NEW.is_active OR NEW.schedule_cron IS NOT NULL
      OR OLD.type IS DISTINCT FROM NEW.type
      OR OLD.config IS DISTINCT FROM NEW.config THEN
      RAISE EXCEPTION 'satellite tracking is retired' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.reject_retired_satellite_scout() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER reject_retired_satellite_scout
BEFORE INSERT OR UPDATE ON public.scouts
FOR EACH ROW EXECUTE FUNCTION public.reject_retired_satellite_scout();

UPDATE public.operator_incidents
SET status = 'resolved', notification_pending = false, resolved_at = now(), updated_at = now(),
    summary = 'Satellite tracking retired'
WHERE kind = 'celestrak_gp_provider_health';

-- Keep the existing RPC signature for vessel callers, but reject GP before
-- reading Vault or allocating a network request.
CREATE OR REPLACE FUNCTION public.trigger_transport_sampler(
  p_task text DEFAULT 'ais', p_operator_bootstrap boolean DEFAULT false
)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_project_url text;
  v_internal_key text;
  v_request_id bigint;
BEGIN
  IF p_task IS DISTINCT FROM 'ais' OR p_operator_bootstrap IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'only the ais transport sampler task is supported';
  END IF;
  SELECT decrypted_secret INTO v_project_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_internal_key FROM vault.decrypted_secrets WHERE name = 'internal_service_key';
  IF v_project_url IS NULL OR v_internal_key IS NULL THEN
    RAISE EXCEPTION 'transport sampler Vault secrets are not configured';
  END IF;
  SELECT net.http_post(
    url := v_project_url || '/functions/v1/transport-sampler',
    headers := jsonb_build_object('X-Service-Key', v_internal_key, 'Content-Type', 'application/json'),
    body := '{"task":"ais"}'::jsonb
  ) INTO v_request_id;
  RETURN v_request_id;
END;
$$;
REVOKE ALL ON FUNCTION public.trigger_transport_sampler(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_transport_sampler(text, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.cleanup_transport_data()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM transport_positions WHERE mmsi IN (
    SELECT mmsi FROM transport_positions
    WHERE seen_at < now() - interval '24 hours' LIMIT 50000
  );
END;
$$;

DROP FUNCTION public.set_transport_gp_refresh_enabled(boolean, text, boolean);
DROP FUNCTION public.acquire_transport_gp_refresh_lease(uuid, integer);
DROP FUNCTION public.complete_transport_gp_refresh(uuid, uuid, timestamptz, integer);
DROP FUNCTION public.halt_transport_gp_refresh(uuid, text, integer, text);
DROP TABLE public.transport_gp_catalog;
DROP TABLE public.transport_gp_refresh_control;

COMMIT;
