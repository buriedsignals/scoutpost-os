BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(17);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000961',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'page-retention@example.test', '',
  now(), now(), now()
);

INSERT INTO public.scouts (
  id, user_id, name, type, url, is_active, schedule_cron
) VALUES (
  '00000000-0000-4000-8000-000000000962',
  '00000000-0000-4000-8000-000000000961',
  'Durable Page Scout', 'web', 'https://example.test/news/',
  true, '0 8 * * *'
);

SELECT ok(
  public.set_page_scout_initial_candidates_if_absent(
    '00000000-0000-4000-8000-000000000962',
    '["https://example.test/news/a"]'::jsonb
  ),
  'first successful index membership is persisted'
);

SELECT is(
  public.set_page_scout_initial_candidates_if_absent(
    '00000000-0000-4000-8000-000000000962',
    '["https://example.test/news/b"]'::jsonb
  ),
  false,
  'later runs cannot rewrite initial index membership'
);

SELECT is(
  (
    SELECT metadata->'page_scout_initial_candidates'
      FROM public.scouts
     WHERE id = '00000000-0000-4000-8000-000000000962'
  ),
  '["https://example.test/news/a"]'::jsonb,
  'the original membership remains authoritative'
);

SELECT ok(
  public.set_page_scout_active_candidates(
    '00000000-0000-4000-8000-000000000962',
    '["https://example.test/news/a"]'::jsonb
  ),
  'current active membership is stored on the scout'
);

SELECT ok(
  public.set_page_scout_active_candidates(
    '00000000-0000-4000-8000-000000000962',
    '["https://example.test/news/b"]'::jsonb
  ),
  'a later authoritative root change replaces active membership'
);

SELECT is(
  (
    SELECT metadata->'page_scout_active_candidates'
      FROM public.scouts
     WHERE id = '00000000-0000-4000-8000-000000000962'
  ),
  '["https://example.test/news/b"]'::jsonb,
  'removed children do not remain active through raw-capture history'
);

SELECT public.set_page_scout_active_candidates(
  '00000000-0000-4000-8000-000000000962',
  '["https://example.test/news/a","https://example.test/news/b"]'::jsonb
);

INSERT INTO public.scout_runs (
  id, scout_id, user_id, status, started_at, completed_at, expires_at
) VALUES
  (
    '00000000-0000-4000-8000-000000000963',
    '00000000-0000-4000-8000-000000000962',
    '00000000-0000-4000-8000-000000000961',
    'success', now() - interval '100 days', now() - interval '100 days',
    now() - interval '1 day'
  ),
  (
    '00000000-0000-4000-8000-000000000964',
    '00000000-0000-4000-8000-000000000962',
    '00000000-0000-4000-8000-000000000961',
    'success', now() - interval '99 days', now() - interval '99 days',
    now() - interval '1 day'
  ),
  (
    '00000000-0000-4000-8000-000000000965',
    '00000000-0000-4000-8000-000000000962',
    '00000000-0000-4000-8000-000000000961',
    'error', now() - interval '98 days', now() - interval '98 days',
    now() - interval '1 day'
  );

INSERT INTO public.raw_captures (
  id, user_id, scout_id, scout_run_id, source_url, content_md,
  canonical_content_sha256, canonicalizer_version, captured_at, expires_at
) VALUES
  (
    '00000000-0000-4000-8000-000000000966',
    '00000000-0000-4000-8000-000000000961',
    '00000000-0000-4000-8000-000000000962',
    '00000000-0000-4000-8000-000000000963',
    'https://example.test/news/a', 'old', repeat('a', 64), 'web-v1',
    now() - interval '100 days', now() - interval '60 days'
  ),
  (
    '00000000-0000-4000-8000-000000000967',
    '00000000-0000-4000-8000-000000000961',
    '00000000-0000-4000-8000-000000000962',
    '00000000-0000-4000-8000-000000000964',
    'https://example.test/news/a', 'new', repeat('b', 64), 'web-v1',
    now() - interval '99 days', now() - interval '60 days'
  ),
  (
    '00000000-0000-4000-8000-000000000968',
    '00000000-0000-4000-8000-000000000961',
    '00000000-0000-4000-8000-000000000962',
    '00000000-0000-4000-8000-000000000965',
    'https://example.test/news/a', 'failed', repeat('c', 64), 'web-v1',
    now() - interval '98 days', now() - interval '60 days'
  ),
  (
    '00000000-0000-4000-8000-000000000969',
    '00000000-0000-4000-8000-000000000961',
    '00000000-0000-4000-8000-000000000962',
    '00000000-0000-4000-8000-000000000964',
    'https://example.test/news/b', 'other source', repeat('d', 64), 'web-v1',
    now() - interval '99 days', now() - interval '60 days'
  ),
  (
    '00000000-0000-4000-8000-000000000970',
    '00000000-0000-4000-8000-000000000961',
    '00000000-0000-4000-8000-000000000962',
    '00000000-0000-4000-8000-000000000964',
    'https://example.test/news/noise', 'not canonical', NULL, NULL,
    now() - interval '99 days', now() - interval '60 days'
  );

SELECT public.cleanup_raw_captures();

SELECT isnt(
  (SELECT id FROM public.raw_captures WHERE id =
    '00000000-0000-4000-8000-000000000967'),
  NULL::uuid,
  'newest successful canonical capture survives raw TTL cleanup'
);

SELECT isnt(
  (SELECT id FROM public.raw_captures WHERE id =
    '00000000-0000-4000-8000-000000000969'),
  NULL::uuid,
  'each Page Scout child keeps its own newest successful baseline'
);

SELECT is(
  (SELECT count(*) FROM public.raw_captures WHERE id IN (
    '00000000-0000-4000-8000-000000000966',
    '00000000-0000-4000-8000-000000000968',
    '00000000-0000-4000-8000-000000000970'
  )),
  0::bigint,
  'older, failed-run, and noncanonical expired captures are deleted'
);

SELECT public.cleanup_scout_runs();

SELECT is(
  (SELECT scout_run_id FROM public.raw_captures WHERE id =
    '00000000-0000-4000-8000-000000000967'),
  NULL::uuid,
  'newest root/child baseline detaches before run expiry'
);

SELECT is(
  (SELECT scout_run_id FROM public.raw_captures WHERE id =
    '00000000-0000-4000-8000-000000000969'),
  NULL::uuid,
  'all retained source baselines survive run deletion'
);

SELECT is(
  (SELECT count(*) FROM public.scout_runs WHERE scout_id =
    '00000000-0000-4000-8000-000000000962'),
  0::bigint,
  'expired run diagnostics are still cleaned up'
);

SELECT is(
  (SELECT count(*) FROM public.raw_captures WHERE scout_id =
    '00000000-0000-4000-8000-000000000962'),
  2::bigint,
  'cleanup retains exactly one canonical baseline per source'
);

SELECT public.set_page_scout_active_candidates(
  '00000000-0000-4000-8000-000000000962',
  '["https://example.test/news/b"]'::jsonb
);
SELECT public.cleanup_raw_captures();

SELECT is(
  (SELECT count(*) FROM public.raw_captures WHERE source_url =
    'https://example.test/news/a'),
  0::bigint,
  'a removed child returns to ordinary raw-capture TTL cleanup'
);

SELECT is(
  (SELECT count(*) FROM public.raw_captures WHERE source_url =
    'https://example.test/news/b'),
  1::bigint,
  'the current active child keeps its one comparison baseline'
);

INSERT INTO public.scouts (
  id, user_id, name, type, url, is_active, schedule_cron
) VALUES (
  '00000000-0000-4000-8000-000000000971',
  '00000000-0000-4000-8000-000000000961',
  'Legacy Page Scout', 'web', 'https://legacy.example.test/news/',
  true, '0 9 * * *'
);
INSERT INTO public.raw_captures (
  id, user_id, scout_id, source_url, content_md,
  canonical_content_sha256, canonicalizer_version, captured_at, expires_at
) VALUES (
  '00000000-0000-4000-8000-000000000972',
  '00000000-0000-4000-8000-000000000961',
  '00000000-0000-4000-8000-000000000971',
  'https://legacy.example.test/news/child', 'legacy child',
  repeat('e', 64), 'web-v1',
  now() - interval '60 days', now() - interval '30 days'
);
SELECT public.cleanup_raw_captures();

SELECT is(
  (SELECT count(*) FROM public.raw_captures WHERE id =
    '00000000-0000-4000-8000-000000000972'),
  1::bigint,
  'legacy scouts keep child baselines until active membership is initialized'
);

SELECT public.set_page_scout_active_candidates(
  '00000000-0000-4000-8000-000000000971',
  '[]'::jsonb
);
SELECT public.cleanup_raw_captures();

SELECT is(
  (SELECT count(*) FROM public.raw_captures WHERE id =
    '00000000-0000-4000-8000-000000000972'),
  0::bigint,
  'initialized active membership restores removed-child TTL cleanup'
);

SELECT * FROM finish();
ROLLBACK;
