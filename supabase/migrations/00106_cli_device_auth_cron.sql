DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-cli-device-auth') THEN
    PERFORM cron.unschedule('cleanup-cli-device-auth');
  END IF;
  PERFORM cron.schedule(
    'cleanup-cli-device-auth',
    '0,5,10,15,20,25,30,35,40,45,50,55 * * * *',
    'SELECT public.cleanup_cli_device_authorizations()'
  );
END
$$;
