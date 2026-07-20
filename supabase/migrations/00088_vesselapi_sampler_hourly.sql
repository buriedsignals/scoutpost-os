-- Use the quota-bounded VesselAPI bulk sampler once per hour. The Basic plan
-- provides 1,500 calls/month; hourly sampling consumes about 720 and leaves a
-- bounded reserve for live config tests and operator canaries.

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
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
        'Content-Type',  'application/json'
      ),
      body := '{"task":"ais"}'::jsonb
    )
    WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
      AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'service_role_key');
  $cmd$
);

COMMIT;
