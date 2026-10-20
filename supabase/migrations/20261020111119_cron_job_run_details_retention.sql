-- Keep 7 days of pg_cron run history.
--
-- cron.job_run_details had no retention: about 730k rows (922 MB) had piled up
-- since April, and every 30-second drain or per-minute HTTP job adds a row.
-- On Small compute that table competed for disk I/O with scout runs
-- (2026-10-19 weekly benchmark: statement timeouts across Page, Civic and
-- Beat writes). Seven days follows the Supabase Cron quickstart's
-- "Clean up job run history" example. Runs still in flight have no end_time,
-- so start_time decides for them.

CREATE OR REPLACE FUNCTION public.cleanup_cron_job_run_details()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, cron
AS $$
DECLARE
  v_count int;
BEGIN
  DELETE FROM cron.job_run_details
   WHERE coalesce(end_time, start_time) < now() - interval '7 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_cron_job_run_details()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_cron_job_run_details() TO service_role;

DO $$
BEGIN
  PERFORM cron.unschedule('cleanup-cron-job-run-details')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-cron-job-run-details');
  PERFORM cron.schedule(
    'cleanup-cron-job-run-details',
    '55 3 * * *',
    'SELECT public.cleanup_cron_job_run_details()'
  );
END;
$$;
