-- 00073_transport_sampler_cron.sql
-- Transport Scout (U3): shared AIS sampler + GP-refresh system crons.
--
-- Two pg_cron jobs POST to the transport-sampler Edge Function with a task
-- discriminator (EF-invoking pattern, mirroring 00022_apify_failsafe):
--   transport-ais-sampler  */30  → { task: "ais" }  vessel position sampler
--   transport-gp-refresh   daily → { task: "gp" }   satellite GP cache (U4)
--
-- Both are unconditional system jobs; the EF itself no-ops when there are no
-- active vessel (resp. satellite) scouts, so an idle deployment does no work.
-- The guards live in the function, not the cron, because "are there active
-- vessel scouts" is a live query the SQL cron would duplicate.

BEGIN;

SELECT cron.unschedule('transport-ais-sampler')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'transport-ais-sampler');

SELECT cron.schedule(
  'transport-ais-sampler',
  '*/30 * * * *',
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

SELECT cron.unschedule('transport-gp-refresh')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'transport-gp-refresh');

SELECT cron.schedule(
  'transport-gp-refresh',
  '17 5 * * *',
  $cmd$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/transport-sampler',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
        'Content-Type',  'application/json'
      ),
      body := '{"task":"gp"}'::jsonb
    )
    WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
      AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'service_role_key');
  $cmd$
);

COMMIT;
