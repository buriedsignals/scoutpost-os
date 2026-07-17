BEGIN;
SELECT plan(5);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) VALUES (
  '00000000-0000-0000-0000-000000000820',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'embedding-cutover@example.test', '',
  now(), now(), now()
);

INSERT INTO scouts (id, user_id, name, type, is_active)
VALUES
  ('00000000-0000-0000-0000-000000000821', '00000000-0000-0000-0000-000000000820', 'Embedding cutover A', 'beat', false),
  ('00000000-0000-0000-0000-000000000822', '00000000-0000-0000-0000-000000000820', 'Embedding cutover B', 'beat', false);

INSERT INTO scout_runs (id, scout_id, user_id, status, completed_at)
VALUES
  ('00000000-0000-0000-0000-000000000823', '00000000-0000-0000-0000-000000000821', '00000000-0000-0000-0000-000000000820', 'success', now()),
  ('00000000-0000-0000-0000-000000000824', '00000000-0000-0000-0000-000000000821', '00000000-0000-0000-0000-000000000820', 'success', now()),
  ('00000000-0000-0000-0000-000000000825', '00000000-0000-0000-0000-000000000822', '00000000-0000-0000-0000-000000000820', 'success', now());

SELECT * FROM upsert_canonical_unit_v2(
  p_user_id := '00000000-0000-0000-0000-000000000820',
  p_statement := 'Zurich approved CHF 12 million to renovate Waidberg secondary school.',
  p_type := 'fact', p_entities := ARRAY['Zurich', 'Waidberg'],
  p_embedding := (ARRAY[1.0::real] || array_fill(0.0::real, ARRAY[767]))::extensions.vector(768),
  p_source_url := 'https://example.test/run-one', p_source_type := 'scout',
  p_statement_hash := repeat('a', 64),
  p_scout_id := '00000000-0000-0000-0000-000000000821', p_scout_type := 'beat',
  p_scout_run_id := '00000000-0000-0000-0000-000000000823'
);
SELECT * FROM upsert_canonical_unit_v2(
  p_user_id := '00000000-0000-0000-0000-000000000820',
  p_statement := 'Zurich approved CHF 12 million to renovate Waidberg secondary school.',
  p_type := 'fact', p_entities := ARRAY['Zurich', 'Waidberg'],
  p_embedding := (ARRAY[1.0::real] || array_fill(0.0::real, ARRAY[767]))::extensions.vector(768),
  p_source_url := 'https://example.test/run-two', p_source_type := 'scout',
  p_statement_hash := repeat('a', 64),
  p_scout_id := '00000000-0000-0000-0000-000000000821', p_scout_type := 'beat',
  p_scout_run_id := '00000000-0000-0000-0000-000000000824'
);
SELECT * FROM upsert_canonical_unit_v2(
  p_user_id := '00000000-0000-0000-0000-000000000820',
  p_statement := 'Zurich granted CHF 12 million for the Waidberg secondary-school renovation.',
  p_type := 'fact', p_entities := ARRAY['Zurich', 'Waidberg'],
  p_embedding := (ARRAY[1.0::real] || array_fill(0.0::real, ARRAY[767]))::extensions.vector(768),
  p_source_url := 'https://example.test/cross-scout', p_source_type := 'scout',
  p_statement_hash := repeat('b', 64),
  p_scout_id := '00000000-0000-0000-0000-000000000822', p_scout_type := 'beat',
  p_scout_run_id := '00000000-0000-0000-0000-000000000825'
);
SELECT * FROM upsert_canonical_unit_v2(
  p_user_id := '00000000-0000-0000-0000-000000000820',
  p_statement := 'Zurich approved CHF 21 million to renovate Waidberg secondary school.',
  p_type := 'fact', p_entities := ARRAY['Zurich', 'Waidberg'],
  p_embedding := (ARRAY[0.99::real, 0.01::real] || array_fill(0.0::real, ARRAY[766]))::extensions.vector(768),
  p_source_url := 'https://example.test/numeric-conflict', p_source_type := 'scout',
  p_statement_hash := repeat('c', 64),
  p_scout_id := '00000000-0000-0000-0000-000000000822', p_scout_type := 'beat',
  p_scout_run_id := '00000000-0000-0000-0000-000000000825'
);

SELECT is(
  (SELECT count(*) FROM information_units WHERE user_id = '00000000-0000-0000-0000-000000000820'),
  2::bigint,
  'same fact merges across runs and scouts while a conflicting number stays separate'
);
SELECT is(
  (SELECT count(DISTINCT unit_id) FROM unit_occurrences
   WHERE user_id = '00000000-0000-0000-0000-000000000820'
     AND statement_hash = repeat('a', 64)),
  1::bigint,
  'same-scout repeats across runs converge on one canonical unit'
);
SELECT is(
  (SELECT count(DISTINCT scout_run_id) FROM unit_occurrences
   WHERE unit_id = (SELECT unit_id FROM unit_occurrences WHERE statement_hash = repeat('a', 64) LIMIT 1)),
  3::bigint,
  'the merged canonical preserves occurrences from all three runs'
);
SELECT is(
  (SELECT count(DISTINCT scout_id) FROM unit_occurrences
   WHERE unit_id = (SELECT unit_id FROM unit_occurrences WHERE statement_hash = repeat('a', 64) LIMIT 1)),
  2::bigint,
  'the semantic merge preserves links to both scouts'
);
SELECT is(
  (SELECT id FROM semantic_search_units_v2(
    p_embedding := (ARRAY[1.0::real] || array_fill(0.0::real, ARRAY[767]))::extensions.vector(768),
    p_user_id := '00000000-0000-0000-0000-000000000820', p_limit := 1
  )),
  (SELECT unit_id FROM unit_occurrences WHERE statement_hash = repeat('a', 64) LIMIT 1),
  'semantic search ranks the intended merged canonical first'
);

SELECT * FROM finish();
ROLLBACK;
