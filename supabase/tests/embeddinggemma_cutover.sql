BEGIN;
SELECT plan(11);

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
  p_embedding_model := 'openrouter-google-gemini-embedding-001-768-zdr-v1',
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
  p_embedding_model := 'openrouter-google-gemini-embedding-001-768-zdr-v1',
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
  p_embedding_model := 'openrouter-google-gemini-embedding-001-768-zdr-v1',
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
  p_embedding_model := 'openrouter-google-gemini-embedding-001-768-zdr-v1',
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
    p_user_id := '00000000-0000-0000-0000-000000000820', p_limit := 1,
    p_embedding_model := 'openrouter-google-gemini-embedding-001-768-zdr-v1'
  )),
  (SELECT unit_id FROM unit_occurrences WHERE statement_hash = repeat('a', 64) LIMIT 1),
  'semantic search ranks the intended merged canonical first'
);

SELECT is(
  (SELECT id FROM semantic_search_units_v2(
    p_embedding := (ARRAY[1.0::real] || array_fill(0.0::real, ARRAY[767]))::extensions.vector(768),
    p_user_id := '00000000-0000-0000-0000-000000000820', p_limit := 1,
    p_embedding_model := 'embeddinggemma-300m-768-int8-onnx-task-prefix-v1'
  )),
  NULL::uuid,
  'semantic search never mixes model spaces'
);

UPDATE information_units
SET embedding_model_v2 = 'embeddinggemma-300m-768-int8-onnx-task-prefix-v1'
WHERE statement LIKE '%CHF 21 million%';

WITH staged AS (
  SELECT stage_embedding_v2_cutover(
    'information_units', id,
    (ARRAY[0.99::real, 0.01::real] || array_fill(0.0::real, ARRAY[766]))::extensions.vector(768),
    'openrouter-google-gemini-embedding-001-768-zdr-v1'
  )
  FROM information_units WHERE statement LIKE '%CHF 21 million%'
)
SELECT pass('a non-target vector can be staged without changing the live row')
FROM staged;

SELECT stage_embedding_v2_cutover(
  'information_units',
  (SELECT unit_id FROM unit_occurrences WHERE statement_hash = repeat('a', 64) LIMIT 1),
  (ARRAY[0.0::real, 1.0::real] || array_fill(0.0::real, ARRAY[766]))::extensions.vector(768),
  'openrouter-google-gemini-embedding-001-768-zdr-v1'
);

SELECT is(
  (apply_embedding_v2_cutover()->'updated'->>'information_units')::int,
  1,
  'the guarded cutover atomically applies the staged vector'
);

SELECT is(
  (SELECT remaining FROM embedding_v2_cutover_inventory()
   WHERE table_name = 'information_units'),
  0::bigint,
  'database-side inventory reports exact remaining coverage'
);

SELECT ok(
  (SELECT (embedding_v2 <=>
    (ARRAY[1.0::real] || array_fill(0.0::real, ARRAY[767]))::extensions.vector(768)) = 0
   FROM information_units
   WHERE id = (SELECT unit_id FROM unit_occurrences
               WHERE statement_hash = repeat('a', 64) LIMIT 1)),
  'apply never overwrites a row already written by the target model'
);

SELECT ok(
  (SELECT embedding_model_v2 = 'openrouter-google-gemini-embedding-001-768-zdr-v1'
   FROM information_units WHERE statement LIKE '%CHF 21 million%')
  AND NOT EXISTS (SELECT 1 FROM embedding_v2_cutover_stage),
  'the applied row has the target tag and staging is empty'
);

SELECT * FROM finish();
ROLLBACK;
