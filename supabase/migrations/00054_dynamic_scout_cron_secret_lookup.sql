-- 00054_dynamic_scout_cron_secret_lookup.sql
-- Keep per-scout pg_cron jobs from embedding the internal service key in
-- cron.job.command. The cron command now reads Vault at execution time, which
-- matches the fixed worker/digest crons and makes key sync/rotation independent
-- of active scout rescheduling.

CREATE OR REPLACE FUNCTION schedule_scout(p_scout_id UUID, p_cron_expr TEXT)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  job_name TEXT := 'scout-' || p_scout_id::text;
  http_cmd TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
    OR NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key')
  THEN
    RAISE EXCEPTION 'vault secrets project_url / internal_service_key must be set before scheduling scouts';
  END IF;

  PERFORM cron.unschedule(job_name)
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = job_name);

  http_cmd := format(
    $fmt$SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/execute-scout',
      headers := jsonb_build_object(
        'X-Service-Key', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_service_key'),
        'Content-Type',  'application/json'
      ),
      body := jsonb_build_object('scout_id', %L::text)
    )
    WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
      AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key')$fmt$,
    p_scout_id
  );

  PERFORM cron.schedule(job_name, p_cron_expr, http_cmd);
END; $$;
