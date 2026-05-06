-- 00057_scout_run_lifecycle_hardening.sql
-- Make manual scout runs and scout deletion fail closed instead of leaving
-- dangling state:
--   - trigger_scout_run() now refuses paused/missing scouts and requires Vault
--     dispatch secrets before inserting a running row.
--   - delete_scout_with_schedule() deletes the pg_cron job and scout row in
--     one transaction.
--   - stale running rows are marked error on a short maintenance cron.

CREATE OR REPLACE FUNCTION public.trigger_scout_run(
  p_scout_id UUID,
  p_user_id UUID
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  run_id UUID;
  project_url TEXT;
  internal_key TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.scouts
    WHERE id = p_scout_id
      AND user_id = p_user_id
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'scout is paused or not found';
  END IF;

  SELECT decrypted_secret
    INTO project_url
    FROM vault.decrypted_secrets
   WHERE name = 'project_url';

  SELECT decrypted_secret
    INTO internal_key
    FROM vault.decrypted_secrets
   WHERE name = 'internal_service_key';

  IF project_url IS NULL OR internal_key IS NULL THEN
    RAISE EXCEPTION 'vault secrets project_url / internal_service_key must be set before triggering scouts';
  END IF;

  INSERT INTO public.scout_runs (scout_id, user_id, status, started_at)
  VALUES (p_scout_id, p_user_id, 'running', NOW())
  RETURNING id INTO run_id;

  PERFORM net.http_post(
    url := project_url || '/functions/v1/execute-scout',
    headers := jsonb_build_object(
      'X-Service-Key', internal_key,
      'Content-Type',  'application/json'
    ),
    body := jsonb_build_object(
      'scout_id', p_scout_id::text,
      'run_id', run_id::text,
      'user_id', p_user_id::text
    )
  );

  RETURN run_id;
END; $$;

CREATE OR REPLACE FUNCTION public.delete_scout_with_schedule(
  p_scout_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  job_name TEXT := 'scout-' || p_scout_id::text;
  deleted_count INTEGER := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.scouts
    WHERE id = p_scout_id
      AND user_id = p_user_id
  ) THEN
    RETURN false;
  END IF;

  PERFORM cron.unschedule(job_name)
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = job_name);

  DELETE FROM public.scouts
   WHERE id = p_scout_id
     AND user_id = p_user_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  RETURN deleted_count > 0;
END; $$;

CREATE OR REPLACE FUNCTION public.cleanup_orphan_scout_cron_jobs()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  job RECORD;
  removed_count INTEGER := 0;
BEGIN
  FOR job IN
    WITH scout_jobs AS (
      SELECT jobname, substring(jobname FROM '^scout-(.*)$')::uuid AS scout_id
      FROM cron.job
      WHERE jobname ~ '^scout-[0-9a-f-]{36}$'
    )
    SELECT sj.jobname
    FROM scout_jobs sj
    LEFT JOIN public.scouts s
      ON s.id = sj.scout_id
    WHERE s.id IS NULL
  LOOP
    PERFORM cron.unschedule(job.jobname);
    removed_count := removed_count + 1;
  END LOOP;

  RETURN removed_count;
END; $$;

CREATE OR REPLACE FUNCTION public.cleanup_stale_scout_runs(
  p_max_age INTERVAL DEFAULT INTERVAL '30 minutes'
)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  updated_count INTEGER := 0;
BEGIN
  UPDATE public.scout_runs
     SET status = 'error',
         error_message = COALESCE(
           error_message,
           'run did not reach a terminal state within the expected execution window'
         ),
         completed_at = NOW()
   WHERE status = 'running'
     AND started_at < NOW() - p_max_age;
  GET DIAGNOSTICS updated_count = ROW_COUNT;

  RETURN updated_count;
END; $$;

REVOKE ALL ON FUNCTION public.trigger_scout_run(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_scout_with_schedule(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_orphan_scout_cron_jobs()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_stale_scout_runs(INTERVAL)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.trigger_scout_run(UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_scout_with_schedule(UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_orphan_scout_cron_jobs()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_scout_runs(INTERVAL)
  TO service_role;

SELECT public.cleanup_stale_scout_runs();
SELECT public.cleanup_orphan_scout_cron_jobs();

DO $$
BEGIN
  PERFORM cron.unschedule('cleanup-stale-scout-runs')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-stale-scout-runs');
  PERFORM cron.schedule(
    'cleanup-stale-scout-runs',
    '*/15 * * * *',
    'SELECT public.cleanup_stale_scout_runs()'
  );

  PERFORM cron.unschedule('cleanup-orphan-scout-cron-jobs')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-orphan-scout-cron-jobs');
  PERFORM cron.schedule(
    'cleanup-orphan-scout-cron-jobs',
    '17 3 * * *',
    'SELECT public.cleanup_orphan_scout_cron_jobs()'
  );
END $$;
