BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(3);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000851',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'civic-claim@example.test', '',
  now(), now(), now()
);

INSERT INTO public.scouts (id, user_id, name, type, is_active)
VALUES
  ('00000000-0000-4000-8000-000000000852', '00000000-0000-4000-8000-000000000851', 'Target A', 'civic', false),
  ('00000000-0000-4000-8000-000000000853', '00000000-0000-4000-8000-000000000851', 'Target B', 'civic', false);

INSERT INTO public.scout_runs (id, scout_id, user_id, status)
VALUES
  ('00000000-0000-4000-8000-000000000854', '00000000-0000-4000-8000-000000000852', '00000000-0000-4000-8000-000000000851', 'running'),
  ('00000000-0000-4000-8000-000000000855', '00000000-0000-4000-8000-000000000853', '00000000-0000-4000-8000-000000000851', 'running');

INSERT INTO public.civic_extraction_queue (
  id, user_id, scout_id, scout_run_id, source_url, doc_kind, status, created_at
) VALUES
  (
    '00000000-0000-4000-8000-000000000856',
    '00000000-0000-4000-8000-000000000851',
    '00000000-0000-4000-8000-000000000852',
    '00000000-0000-4000-8000-000000000854',
    'https://example.test/older', 'html', 'pending', now() - interval '1 minute'
  ),
  (
    '00000000-0000-4000-8000-000000000857',
    '00000000-0000-4000-8000-000000000851',
    '00000000-0000-4000-8000-000000000853',
    '00000000-0000-4000-8000-000000000855',
    'https://example.test/target', 'html', 'pending', now()
  );

SELECT is(
  (
    SELECT scout_run_id
      FROM public.claim_civic_queue_item(
        'targeted-worker',
        '00000000-0000-4000-8000-000000000855'
      )
  ),
  '00000000-0000-4000-8000-000000000855'::uuid,
  'targeted claim selects only the requested run'
);

SELECT is(
  (
    SELECT status
      FROM public.civic_extraction_queue
     WHERE id = '00000000-0000-4000-8000-000000000856'
  ),
  'pending',
  'targeted claim leaves unrelated older work untouched'
);

SELECT is(
  (
    SELECT scout_run_id
      FROM public.claim_civic_queue_item('global-worker', NULL)
  ),
  '00000000-0000-4000-8000-000000000854'::uuid,
  'global worker still claims the oldest pending row'
);

SELECT * FROM finish();
ROLLBACK;
