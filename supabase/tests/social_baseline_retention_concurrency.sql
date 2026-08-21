CREATE EXTENSION IF NOT EXISTS dblink;

SELECT plan(9);

CREATE FUNCTION pg_temp.retention_dblink_connstr()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN inet_server_addr() IS NULL
      THEN format(
        'host=host.docker.internal port=54322 dbname=%I user=postgres password=postgres',
        current_database()
      )
    ELSE format(
      'host=%s port=%s dbname=%I user=postgres password=postgres',
      inet_server_addr(),
      inet_server_port(),
      current_database()
    )
  END;
$$;

CREATE FUNCTION pg_temp.social_resume_waits_for_cleanup(
  p_scout_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('lock_timeout', '250ms', true);
  PERFORM public.prepare_social_scout_resume(p_scout_id, p_user_id);
  RETURN false;
EXCEPTION
  WHEN lock_not_available THEN RETURN true;
END;
$$;

DELETE FROM auth.users
 WHERE id = '00000000-0000-4000-8000-00000000045b';
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-00000000045b',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'social-retention-race@example.test',
  '',
  now(),
  now(),
  now()
);

INSERT INTO public.scouts (
  id, user_id, name, type, platform, profile_handle,
  is_active, schedule_cron, baseline_established_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-00000000045c',
  '00000000-0000-4000-8000-00000000045b',
  'Resume wins cleanup race',
  'social',
  'instagram',
  'resume-wins',
  false,
  '0 8 * * *',
  now(),
  now() - interval '120 days'
);
INSERT INTO public.post_snapshots (
  scout_id, user_id, platform, handle, post_count, posts
) VALUES (
  '00000000-0000-4000-8000-00000000045c',
  '00000000-0000-4000-8000-00000000045b',
  'instagram',
  'resume-wins',
  1,
  '[{"id":"resume-wins"}]'::jsonb
);

DO $$
BEGIN
  PERFORM dblink_connect('retention_resume', pg_temp.retention_dblink_connstr());
  PERFORM dblink_exec('retention_resume', 'BEGIN');
END;
$$;

SELECT is(
  (
    SELECT needs_baseline
      FROM dblink(
        'retention_resume',
        $remote$
          SELECT public.prepare_social_scout_resume(
            '00000000-0000-4000-8000-00000000045c',
            '00000000-0000-4000-8000-00000000045b'
          )
        $remote$
      ) AS result(needs_baseline boolean)
  ),
  false,
  'resume reservation recognizes an existing ready baseline'
);
SELECT is(
  public.cleanup_inactive_post_snapshots(1),
  0,
  'cleanup skips a scout locked by concurrent resume'
);
SELECT is(
  (SELECT count(*) FROM public.post_snapshots
    WHERE scout_id = '00000000-0000-4000-8000-00000000045c'),
  1::bigint,
  'resume-winning interleaving preserves the snapshot'
);

DO $$
BEGIN
  PERFORM dblink_exec('retention_resume', 'COMMIT');
END;
$$;
SELECT is(
  public.cleanup_inactive_post_snapshots(1),
  0,
  'cleanup rechecks committed resume freshness before retiring a baseline'
);

INSERT INTO public.scouts (
  id, user_id, name, type, platform, profile_handle,
  is_active, schedule_cron, baseline_established_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-00000000045d',
  '00000000-0000-4000-8000-00000000045b',
  'Cleanup wins resume race',
  'social',
  'instagram',
  'cleanup-wins',
  false,
  '0 8 * * *',
  now(),
  now() - interval '130 days'
);
INSERT INTO public.post_snapshots (
  scout_id, user_id, platform, handle, post_count, posts
) VALUES (
  '00000000-0000-4000-8000-00000000045d',
  '00000000-0000-4000-8000-00000000045b',
  'instagram',
  'cleanup-wins',
  1,
  '[{"id":"cleanup-wins"}]'::jsonb
);

DO $$
BEGIN
  PERFORM dblink_connect('retention_cleanup', pg_temp.retention_dblink_connstr());
  PERFORM dblink_exec('retention_cleanup', 'BEGIN');
END;
$$;
SELECT is(
  (
    SELECT deleted_count
      FROM dblink(
        'retention_cleanup',
        'SELECT public.cleanup_inactive_post_snapshots(1)'
      ) AS result(deleted_count integer)
  ),
  1,
  'cleanup retires one baseline while retaining its row locks'
);
SELECT ok(
  pg_temp.social_resume_waits_for_cleanup(
    '00000000-0000-4000-8000-00000000045d',
    '00000000-0000-4000-8000-00000000045b'
  ),
  'resume serializes behind cleanup on the same scout'
);

DO $$
BEGIN
  PERFORM dblink_exec('retention_cleanup', 'COMMIT');
END;
$$;
SELECT is(
  public.prepare_social_scout_resume(
    '00000000-0000-4000-8000-00000000045d',
    '00000000-0000-4000-8000-00000000045b'
  ),
  true,
  'resume observes cleanup and requires a replacement baseline'
);
SELECT is(
  (SELECT count(*) FROM public.scouts
    WHERE id = '00000000-0000-4000-8000-00000000045d'
      AND baseline_established_at IS NULL),
  1::bigint,
  'cleanup-winning interleaving clears readiness atomically'
);
SELECT is(
  (SELECT count(*) FROM public.post_snapshots
    WHERE scout_id = '00000000-0000-4000-8000-00000000045d'),
  0::bigint,
  'cleanup-winning interleaving removes the snapshot atomically'
);

SELECT * FROM finish();

DO $$
BEGIN
  PERFORM dblink_disconnect('retention_resume');
  PERFORM dblink_disconnect('retention_cleanup');
END;
$$;
DELETE FROM public.post_snapshots
 WHERE user_id = '00000000-0000-4000-8000-00000000045b';
DELETE FROM public.scouts
 WHERE user_id = '00000000-0000-4000-8000-00000000045b';
DELETE FROM auth.users
 WHERE id = '00000000-0000-4000-8000-00000000045b';
DROP EXTENSION dblink;
