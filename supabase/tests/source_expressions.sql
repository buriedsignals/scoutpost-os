BEGIN;
SELECT plan(12);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '00000000-0000-0000-0000-000000000080') THEN
    INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at)
    VALUES ('00000000-0000-0000-0000-000000000080', '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated', 'expression-test@example.test', '', now(), now(), now());
  END IF;
END $$;

INSERT INTO raw_captures (id, user_id, content_md, content_sha256)
VALUES ('00000000-0000-0000-0000-000000000081', '00000000-0000-0000-0000-000000000080',
        E'intro\ncafé proof\nend', 'client-supplied-hash-is-not-evidence-hash');
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000000082', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'other-expression-test@example.test', '', now(), now(), now());
INSERT INTO raw_captures (id, user_id, content_md)
VALUES ('00000000-0000-0000-0000-000000000083', '00000000-0000-0000-0000-000000000082', 'other source');

SELECT * FROM upsert_canonical_unit(
  p_user_id := '00000000-0000-0000-0000-000000000080',
  p_statement := 'The café has proof.', p_type := 'fact',
  p_source_type := 'manual_ingest', p_raw_capture_id := '00000000-0000-0000-0000-000000000081',
  p_statement_hash := 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
);

SELECT lives_ok(
  $$SELECT record_source_expression(
    '00000000-0000-0000-0000-000000000080',
    '00000000-0000-0000-0000-000000000081',
    (SELECT id FROM information_units WHERE user_id = '00000000-0000-0000-0000-000000000080'),
    (SELECT id FROM unit_occurrences WHERE user_id = '00000000-0000-0000-0000-000000000080'),
    6, 17, 'supports')$$,
  'record_source_expression derives an exact UTF-8 byte slice'
);
SELECT is((SELECT exact_text FROM source_expressions), 'café proof', 'stored text is the exact source passage');
SELECT isnt((SELECT capture_payload_sha256 FROM source_expressions),
            'client-supplied-hash-is-not-evidence-hash', 'capture hash is computed from stored content');
SELECT lives_ok(
  $$SELECT record_source_expression(
    '00000000-0000-0000-0000-000000000080',
    '00000000-0000-0000-0000-000000000081',
    (SELECT id FROM information_units WHERE user_id = '00000000-0000-0000-0000-000000000080'),
    NULL, 6, 17, 'supports')$$,
  'retrying the same anchor is idempotent'
);
SELECT is((SELECT count(*) FROM source_expressions), 1::bigint, 'idempotency does not duplicate expressions');
SELECT throws_ok(
  $$UPDATE source_expressions SET exact_text = 'changed'$$,
  NULL, 'source expression core fields are immutable'
);
SELECT throws_ok(
  $$UPDATE raw_captures SET content_md = 'changed' WHERE id = '00000000-0000-0000-0000-000000000081'$$,
  NULL, 'capture content cannot change once an expression exists'
);
SELECT lives_ok(
  $$SELECT review_source_expression_link(
    '00000000-0000-0000-0000-000000000080',
    (SELECT id FROM source_expression_links), 'accepted', 'verified')$$,
  'owner can accept an evidence relation'
);
SELECT is((SELECT review_status FROM source_expression_links), 'accepted', 'review status is stored separately from the anchor');
SELECT throws_ok(
  $$SELECT record_source_expression(
    '00000000-0000-0000-0000-000000000080',
    '00000000-0000-0000-0000-000000000083',
    (SELECT id FROM information_units WHERE user_id = '00000000-0000-0000-0000-000000000080'),
    NULL, 0, 1, 'supports')$$,
  NULL, 'cross-tenant captures cannot be linked'
);
SELECT is((SELECT count(*) FROM source_expression_links), 1::bigint, 'expression links to its canonical unit');
DELETE FROM raw_captures WHERE id = '00000000-0000-0000-0000-000000000081';
SELECT is((SELECT count(*) FROM source_expressions), 0::bigint, 'capture retention cascades to expressions');

SELECT * FROM finish();
ROLLBACK;
