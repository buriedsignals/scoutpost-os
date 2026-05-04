-- 00053_internal_service_key_boundary.sql
-- Move DB/cron-triggered Edge Function calls onto the dedicated internal
-- service boundary. Vault still stores the project URL for pg_net, but the
-- credential is now internal_service_key and is sent as X-Service-Key.

CREATE OR REPLACE FUNCTION schedule_scout(p_scout_id UUID, p_cron_expr TEXT)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  job_name TEXT := 'scout-' || p_scout_id::text;
  project_url TEXT;
  internal_key TEXT;
  http_cmd TEXT;
BEGIN
  SELECT decrypted_secret INTO project_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO internal_key FROM vault.decrypted_secrets WHERE name = 'internal_service_key';
  IF project_url IS NULL OR internal_key IS NULL THEN
    RAISE EXCEPTION 'vault secrets project_url / internal_service_key must be set before scheduling scouts';
  END IF;

  PERFORM cron.unschedule(job_name)
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = job_name);

  http_cmd := format(
    $fmt$SELECT net.http_post(
      url := %L || '/functions/v1/execute-scout',
      headers := jsonb_build_object(
        'X-Service-Key', %L,
        'Content-Type',  'application/json'
      ),
      body := jsonb_build_object('scout_id', %L::text)
    )$fmt$,
    project_url, internal_key, p_scout_id
  );

  PERFORM cron.schedule(job_name, p_cron_expr, http_cmd);
END; $$;

CREATE OR REPLACE FUNCTION trigger_scout_run(p_scout_id UUID, p_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  run_id UUID;
  project_url TEXT;
  internal_key TEXT;
BEGIN
  INSERT INTO scout_runs (scout_id, user_id, status, started_at)
  VALUES (p_scout_id, p_user_id, 'running', NOW())
  RETURNING id INTO run_id;

  SELECT decrypted_secret INTO project_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO internal_key FROM vault.decrypted_secrets WHERE name = 'internal_service_key';

  IF project_url IS NOT NULL AND internal_key IS NOT NULL THEN
    PERFORM net.http_post(
      url := project_url || '/functions/v1/execute-scout',
      headers := jsonb_build_object(
        'X-Service-Key', internal_key,
        'Content-Type',  'application/json'
      ),
      body := jsonb_build_object(
        'scout_id',   p_scout_id::text,
        'run_id',     run_id::text,
        'user_id',    p_user_id::text
      )
    );
  END IF;

  RETURN run_id;
END; $$;

DO $$
BEGIN
  PERFORM cron.unschedule('civic-extract-worker')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'civic-extract-worker');
  PERFORM cron.schedule(
    'civic-extract-worker',
    '*/2 * * * *',
    $cmd$
      SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/civic-extract-worker',
        headers := jsonb_build_object(
          'X-Service-Key', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_service_key'),
          'Content-Type',  'application/json'
        ),
        body := '{}'::jsonb
      )
      WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
        AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key');
    $cmd$
  );

  PERFORM cron.unschedule('apify-reconcile')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'apify-reconcile');
  PERFORM cron.schedule(
    'apify-reconcile',
    '*/10 * * * *',
    $cmd$
      SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/apify-reconcile',
        headers := jsonb_build_object(
          'X-Service-Key', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_service_key'),
          'Content-Type',  'application/json'
        ),
        body := '{}'::jsonb
      )
      WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
        AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key');
    $cmd$
  );

  PERFORM cron.unschedule('scout-health-monitor')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'scout-health-monitor');
  PERFORM cron.schedule(
    'scout-health-monitor',
    '0 9 * * 1',
    $cmd$
      SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/scout-health-monitor',
        headers := jsonb_build_object(
          'X-Service-Key', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_service_key'),
          'Content-Type',  'application/json'
        ),
        body := '{}'::jsonb
      )
      WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
        AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key');
    $cmd$
  );

  PERFORM cron.unschedule('promise-digest')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'promise-digest');
  PERFORM cron.schedule(
    'promise-digest',
    '0 8 * * *',
    $cmd$
      SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/promise-digest',
        headers := jsonb_build_object(
          'X-Service-Key', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_service_key'),
          'Content-Type',  'application/json'
        ),
        body := '{}'::jsonb
      )
      WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
        AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key');
    $cmd$
  );
END $$;

DO $$
DECLARE
  s RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
    AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key')
  THEN
    FOR s IN
      SELECT id, schedule_cron FROM scouts
      WHERE is_active = true AND schedule_cron IS NOT NULL
    LOOP
      PERFORM schedule_scout(s.id, s.schedule_cron);
    END LOOP;
  END IF;
END $$;
