BEGIN;
SELECT plan(5);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '00000000-0000-0000-0000-000000000079') THEN
    INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at)
    VALUES ('00000000-0000-0000-0000-000000000079', '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated', 'dedup-test@example.test', '', now(), now(), now());
  END IF;
END $$;

SELECT is(
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'upsert_canonical_unit'),
  1::bigint,
  'only the fact-check-aware canonical upsert signature remains callable'
);

SELECT * FROM upsert_canonical_unit(
  p_user_id := '00000000-0000-0000-0000-000000000079',
  p_statement := 'The council approved the budget.', p_type := 'fact',
  p_source_url := 'https://example.test/story', p_source_type := 'manual_ingest',
  p_statement_hash := 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
);
SELECT * FROM upsert_canonical_unit(
  p_user_id := '00000000-0000-0000-0000-000000000079',
  p_statement := 'The council delayed the vote.', p_type := 'fact',
  p_source_url := 'https://example.test/story', p_source_type := 'manual_ingest',
  p_statement_hash := 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
);
SELECT * FROM upsert_canonical_unit(
  p_user_id := '00000000-0000-0000-0000-000000000079',
  p_statement := 'The council approved the budget.', p_type := 'fact',
  p_source_url := 'https://another.example.test/reprint', p_source_type := 'manual_ingest',
  p_statement_hash := 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
);

SELECT is(
  (SELECT count(*) FROM information_units WHERE user_id = '00000000-0000-0000-0000-000000000079'),
  2::bigint,
  'different propositions from one URL remain distinct canonical units'
);
SELECT is(
  (SELECT count(DISTINCT unit_id) FROM unit_occurrences
   WHERE user_id = '00000000-0000-0000-0000-000000000079'
     AND statement_hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  1::bigint,
  'the same normalized proposition across URLs merges canonically'
);
SELECT is(
  (SELECT count(*) FROM unit_occurrences
   WHERE user_id = '00000000-0000-0000-0000-000000000079'
     AND statement_hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  2::bigint,
  'a cross-source exact merge keeps both occurrences'
);
SELECT is(
  (SELECT count(DISTINCT statement_hash) FROM unit_occurrences
   WHERE user_id = '00000000-0000-0000-0000-000000000079'),
  2::bigint,
  'occurrences preserve proposition-level statement hashes'
);

SELECT * FROM finish();
ROLLBACK;
