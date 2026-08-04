-- Operator-owned post-Gate-B step. Do not apply before the sanitized Gate B
-- report passes every hard criterion and production routing is still 0%.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'crawler-workflow-dispatch'
  ) THEN
    RAISE EXCEPTION 'crawler-workflow-dispatch already exists';
  END IF;
  PERFORM cron.schedule(
    'crawler-workflow-dispatch',
    '* * * * *',
    $cmd$
      SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets
                WHERE name = 'project_url') || '/functions/v1/crawler-dispatch',
        headers := jsonb_build_object(
          'X-Service-Key', (SELECT decrypted_secret FROM vault.decrypted_secrets
                            WHERE name = 'internal_service_key'),
          'Content-Type', 'application/json'
        ),
        body := '{"mode":"scheduled"}'::jsonb
      )
      WHERE EXISTS (
        SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url'
      )
        AND EXISTS (
          SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key'
        );
    $cmd$
  );
END;
$$;
