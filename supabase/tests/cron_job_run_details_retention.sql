BEGIN;
SELECT plan(4);

INSERT INTO cron.job_run_details (jobid, runid, status, start_time, end_time)
VALUES
  (0, -1, 'succeeded', now() - interval '9 days', now() - interval '9 days'),
  (0, -2, 'succeeded', now() - interval '2 days', now() - interval '2 days'),
  (0, -3, 'running',   now() - interval '9 days', NULL),
  (0, -4, 'running',   now() - interval '1 hour', NULL);

SELECT public.cleanup_cron_job_run_details();

SELECT is(
  (SELECT array_agg(runid ORDER BY runid DESC) FROM cron.job_run_details WHERE runid < 0),
  ARRAY[-2, -4]::bigint[],
  'only runs that ended, or started, more than 7 days ago are purged');

SELECT is(
  (SELECT schedule FROM cron.job WHERE jobname = 'cleanup-cron-job-run-details'),
  '55 3 * * *',
  'cleanup-cron-job-run-details runs daily at 03:55');

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.cleanup_cron_job_run_details()', 'EXECUTE'),
  'authenticated users cannot purge cron history');

SELECT ok(
  NOT has_function_privilege('anon', 'public.cleanup_cron_job_run_details()', 'EXECUTE'),
  'anonymous users cannot purge cron history');

SELECT * FROM finish();
ROLLBACK;
