BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(26);

CREATE FUNCTION pg_temp.call_prepare_social_scout_resume(
  p_scout_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_needs_baseline boolean;
BEGIN
  IF to_regprocedure(
    'public.prepare_social_scout_resume(uuid,uuid)'
  ) IS NULL THEN
    RETURN NULL;
  END IF;
  EXECUTE
    'SELECT public.prepare_social_scout_resume($1, $2)'
    INTO v_needs_baseline
    USING p_scout_id, p_user_id;
  RETURN v_needs_baseline;
END;
$$;

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000445',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'social-retention@example.test', '',
  now(), now(), now()
);

INSERT INTO public.scouts (
  id, user_id, name, type, platform, profile_handle,
  is_active, schedule_cron, updated_at
) VALUES
  ('00000000-0000-4000-8000-000000000446',
   '00000000-0000-4000-8000-000000000445', 'Instagram identity',
   'social', 'instagram', 'ig', true, '0 8 * * *', now()),
  ('00000000-0000-4000-8000-000000000447',
   '00000000-0000-4000-8000-000000000445', 'X identity',
   'social', 'x', 'x-user', true, '0 8 * * *', now()),
  ('00000000-0000-4000-8000-000000000448',
   '00000000-0000-4000-8000-000000000445', 'Facebook identity',
   'social', 'facebook', 'fb-user', true, '0 8 * * *', now()),
  ('00000000-0000-4000-8000-000000000449',
   '00000000-0000-4000-8000-000000000445', 'LinkedIn identity',
   'social', 'linkedin', 'li-user', true, '0 8 * * *', now()),
  ('00000000-0000-4000-8000-000000000450',
   '00000000-0000-4000-8000-000000000445', 'TikTok identity',
   'social', 'tiktok', 'tt-user', true, '0 8 * * *', now());

INSERT INTO public.post_snapshots (
  scout_id, user_id, platform, handle, post_count, posts
) VALUES
  ('00000000-0000-4000-8000-000000000446',
   '00000000-0000-4000-8000-000000000445', 'instagram', 'ig', 99,
   '[{"shortCode":"IG-CODE","id":"conflict","caption":"private text","image_url":"https://example.test/private.jpg"},{"shortcode":42,"id":"IG-SAFE-NUMERIC"},{"shortcode":9007199254740992,"id":"IG-UNSAFE-NUMERIC-FALLBACK"},{"shortcode":"\tIG-TAB\t","id":"IG-TAB-FALLBACK"},{"shortcode":"IG-CODE"},{"shortcode":true,"id":"IG-BOOL-FALLBACK"},{"shortcode":[],"id":"IG-ARRAY-FALLBACK"},{"shortcode":{},"id":"IG-OBJECT-FALLBACK"},"already-minimal",{"noResults":true},null]'::jsonb),
  ('00000000-0000-4000-8000-000000000447',
   '00000000-0000-4000-8000-000000000445', 'x', 'x-user', 99,
   '[{"conversationId":"X-CONVERSATION","fullText":"private text"}]'::jsonb),
  ('00000000-0000-4000-8000-000000000448',
   '00000000-0000-4000-8000-000000000445', 'facebook', 'fb-user', 99,
   '[{"post_id":"FB-POST","message":"private text"}]'::jsonb),
  ('00000000-0000-4000-8000-000000000449',
   '00000000-0000-4000-8000-000000000445', 'linkedin', 'li-user', 99,
   '[{"entityId":"LI-ENTITY","content":"private text"}]'::jsonb),
  ('00000000-0000-4000-8000-000000000450',
   '00000000-0000-4000-8000-000000000445', 'tiktok', 'tt-user', 99,
   '[{"aweme_id":"7636022633884142862","desc":"private text"}]'::jsonb);


SELECT is(
  (SELECT posts FROM public.post_snapshots
    WHERE scout_id = '00000000-0000-4000-8000-000000000446'),
  '[{"id":"IG-CODE"},{"id":"42"},{"id":"IG-UNSAFE-NUMERIC-FALLBACK"},{"id":"IG-TAB"},{"id":"IG-BOOL-FALLBACK"},{"id":"IG-ARRAY-FALLBACK"},{"id":"IG-OBJECT-FALLBACK"},{"id":"already-minimal"}]'::jsonb,
  'Instagram legacy aliases preserve safe integers, whitespace trimming, and reject unsafe numeric values before fallback'
);
SELECT is(
  (SELECT posts FROM public.post_snapshots
    WHERE scout_id = '00000000-0000-4000-8000-000000000447'),
  '[{"id":"X-CONVERSATION"}]'::jsonb,
  'X conversationId legacy rows become minimal identities'
);
SELECT is(
  (SELECT posts FROM public.post_snapshots
    WHERE scout_id = '00000000-0000-4000-8000-000000000448'),
  '[{"id":"FB-POST"}]'::jsonb,
  'Facebook post_id legacy rows become minimal identities'
);
SELECT is(
  (SELECT posts FROM public.post_snapshots
    WHERE scout_id = '00000000-0000-4000-8000-000000000449'),
  '[{"id":"LI-ENTITY"}]'::jsonb,
  'LinkedIn entityId legacy rows become minimal identities'
);
SELECT is(
  (SELECT posts FROM public.post_snapshots
    WHERE scout_id = '00000000-0000-4000-8000-000000000450'),
  '[{"id":"7636022633884142862"}]'::jsonb,
  'TikTok large string aweme_id values preserve exact decimal identities'
);
SELECT is(
  (SELECT post_count FROM public.post_snapshots
    WHERE scout_id = '00000000-0000-4000-8000-000000000446'),
  8,
  'post_count follows the unique minimal identity count'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.normalize_social_baseline_posts(text,jsonb)',
    'EXECUTE'
  ),
  'anonymous callers cannot execute the baseline normalizer'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.normalize_social_baseline_posts(text,jsonb)',
    'EXECUTE'
  ),
  'authenticated callers cannot execute the baseline normalizer'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.normalize_social_baseline_posts(text,jsonb)',
    'EXECUTE'
  ),
  'service role retains access to the baseline normalizer'
);
SELECT ok(
  coalesce(
    NOT has_function_privilege(
      'authenticated',
      to_regprocedure('public.prepare_social_scout_resume(uuid,uuid)'),
      'EXECUTE'
    ),
    false
  ),
  'authenticated callers cannot reserve cross-user Social Scout resume'
);
SELECT ok(
  coalesce(
    has_function_privilege(
      'service_role',
      to_regprocedure('public.prepare_social_scout_resume(uuid,uuid)'),
      'EXECUTE'
    ),
    false
  ),
  'service role can serialize Social Scout resume with cleanup'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.cleanup_inactive_post_snapshots(integer)',
    'EXECUTE'
  ),
  'authenticated users cannot invoke cross-user baseline cleanup'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.cleanup_inactive_post_snapshots(integer)',
    'EXECUTE'
  ),
  'service role can invoke inactive baseline cleanup'
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM cron.job
     WHERE jobname = 'cleanup-inactive-post-snapshots'
       AND schedule = '45 3 * * *'
       AND command LIKE '%cleanup_inactive_post_snapshots%'
  ),
  'inactive baseline cleanup is scheduled in the staggered cleanup window'
);

INSERT INTO public.scouts (
  id, user_id, name, type, platform, profile_handle,
  is_active, schedule_cron, baseline_established_at, updated_at
) VALUES
  ('00000000-0000-4000-8000-000000000451',
   '00000000-0000-4000-8000-000000000445', 'Inactive 120 days',
   'social', 'instagram', 'old-120', false, NULL, now(), now() - interval '120 days'),
  ('00000000-0000-4000-8000-000000000452',
   '00000000-0000-4000-8000-000000000445', 'Inactive 110 days',
   'social', 'instagram', 'old-110', false, NULL, now(), now() - interval '110 days'),
  ('00000000-0000-4000-8000-000000000453',
   '00000000-0000-4000-8000-000000000445', 'Inactive 100 days',
   'social', 'instagram', 'old-100', false, NULL, now(), now() - interval '100 days'),
  ('00000000-0000-4000-8000-000000000454',
   '00000000-0000-4000-8000-000000000445', 'Inactive 90 days',
   'social', 'instagram', 'old-90', false, NULL, now(), now() - interval '90 days'),
  ('00000000-0000-4000-8000-000000000455',
   '00000000-0000-4000-8000-000000000445', 'Active old scout',
   'social', 'instagram', 'active-old', true, '0 8 * * *', now(), now() - interval '120 days'),
  ('00000000-0000-4000-8000-000000000456',
   '00000000-0000-4000-8000-000000000445', 'Recently paused scout',
   'social', 'instagram', 'recent-pause', false, NULL, now(), now() - interval '89 days');

INSERT INTO public.post_snapshots (
  scout_id, user_id, platform, handle, post_count, posts
)
SELECT id, user_id, platform, profile_handle, 1, '["baseline"]'::jsonb
  FROM public.scouts
 WHERE id BETWEEN
   '00000000-0000-4000-8000-000000000451'::uuid
   AND '00000000-0000-4000-8000-000000000456'::uuid;

SELECT is(
  public.cleanup_inactive_post_snapshots(2),
  2,
  'cleanup deletes at most the requested batch size'
);
SELECT is(
  (SELECT count(*) FROM public.post_snapshots
    WHERE scout_id IN (
      '00000000-0000-4000-8000-000000000451',
      '00000000-0000-4000-8000-000000000452'
    )),
  0::bigint,
  'cleanup removes the oldest eligible inactive baselines first'
);
SELECT is(
  (SELECT count(*) FROM public.scouts
    WHERE id IN (
      '00000000-0000-4000-8000-000000000451',
      '00000000-0000-4000-8000-000000000452'
    )
      AND baseline_established_at IS NULL),
  2::bigint,
  'cleanup clears readiness in the same batch that removes each baseline'
);
SELECT is(
  (SELECT count(*) FROM public.post_snapshots
    WHERE scout_id = '00000000-0000-4000-8000-000000000455'),
  1::bigint,
  'cleanup preserves active scouts regardless of age'
);
SELECT is(
  (SELECT count(*) FROM public.post_snapshots
    WHERE scout_id = '00000000-0000-4000-8000-000000000456'),
  1::bigint,
  'cleanup preserves scouts inactive for less than 90 days'
);
SELECT is(
  public.cleanup_inactive_post_snapshots(10),
  2,
  'cleanup includes the exact 90-day inactivity boundary'
);
SELECT is(
  (SELECT count(*) FROM public.post_snapshots
    WHERE scout_id IN (
      '00000000-0000-4000-8000-000000000451',
      '00000000-0000-4000-8000-000000000452',
      '00000000-0000-4000-8000-000000000453',
      '00000000-0000-4000-8000-000000000454'
    )),
  0::bigint,
  'successive bounded calls drain every eligible inactive baseline'
);
SELECT is(
  (SELECT count(*) FROM public.scouts
    WHERE id IN (
      '00000000-0000-4000-8000-000000000451',
      '00000000-0000-4000-8000-000000000452',
      '00000000-0000-4000-8000-000000000453',
      '00000000-0000-4000-8000-000000000454'
    )
      AND baseline_established_at IS NULL),
  4::bigint,
  'every retired baseline leaves its scout explicitly not ready'
);
SELECT is(
  public.cleanup_inactive_post_snapshots(10),
  0,
  'cleanup is idempotent once no eligible rows remain'
);
SELECT is(
  pg_temp.call_prepare_social_scout_resume(
    '00000000-0000-4000-8000-000000000451',
    '00000000-0000-4000-8000-000000000445'
  ),
  true,
  'resume requires a baseline rebuild after inactive cleanup'
);

INSERT INTO public.post_snapshots (
  scout_id, user_id, platform, handle, post_count, posts
) VALUES (
  '00000000-0000-4000-8000-000000000451',
  '00000000-0000-4000-8000-000000000445',
  'instagram',
  'old-120',
  1,
  '[{"id":"rebuilt-baseline"}]'::jsonb
);
UPDATE public.scouts
   SET baseline_established_at = now()
 WHERE id = '00000000-0000-4000-8000-000000000451';

SELECT is(
  pg_temp.call_prepare_social_scout_resume(
    '00000000-0000-4000-8000-000000000451',
    '00000000-0000-4000-8000-000000000445'
  ),
  false,
  'resume recognizes the rebuilt snapshot and readiness marker'
);

DELETE FROM public.scouts
 WHERE id = '00000000-0000-4000-8000-000000000455';
SELECT is(
  (SELECT count(*) FROM public.post_snapshots
    WHERE scout_id = '00000000-0000-4000-8000-000000000455'),
  0::bigint,
  'deleting a scout cascades to its post snapshot baseline'
);

SELECT * FROM finish();
ROLLBACK;
