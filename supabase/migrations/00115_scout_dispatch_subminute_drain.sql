-- Give each bounded drain a fresh Edge Function request trace while keeping a
-- 326-row Monday burst comfortably below the queue-delay alert threshold.
DO $$
BEGIN
  PERFORM cron.unschedule('drain-scout-dispatch')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-scout-dispatch');

  PERFORM cron.schedule(
    'drain-scout-dispatch',
    '30 seconds',
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
