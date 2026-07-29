BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(41);

SELECT has_table('public', 'cli_device_authorizations',
  'device authorization table exists');
SELECT has_table('public', 'cli_auth_rate_limits',
  'atomic rate limit table exists');
SELECT has_column('public', 'api_keys', 'source',
  'API keys record their creation source');
SELECT has_column('public', 'api_keys', 'device_authorization_id',
  'CLI keys can be traced to a consumed request');

SELECT ok((SELECT relrowsecurity FROM pg_class WHERE relname = 'cli_device_authorizations'),
  'device authorizations enforce RLS');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE relname = 'cli_auth_rate_limits'),
  'rate limits enforce RLS');

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.consume_cli_auth_rate_limit(text,text,integer,integer)'),
      ('public.create_api_key_atomic(uuid,text,text)'),
      ('public.decide_cli_device_authorization(text,uuid,text)'),
      ('public.redeem_cli_device_authorization(text)'),
      ('public.validate_api_key_identity(text)'),
      ('public.revoke_current_api_key(text)'),
      ('public.cleanup_cli_device_authorizations()')
    ) AS rpc(signature)
    WHERE has_function_privilege('anon', signature, 'EXECUTE')
  ),
  'anon cannot execute CLI auth SECURITY DEFINER RPCs'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.consume_cli_auth_rate_limit(text,text,integer,integer)'),
      ('public.create_api_key_atomic(uuid,text,text)'),
      ('public.decide_cli_device_authorization(text,uuid,text)'),
      ('public.redeem_cli_device_authorization(text)'),
      ('public.validate_api_key_identity(text)'),
      ('public.revoke_current_api_key(text)'),
      ('public.cleanup_cli_device_authorizations()')
    ) AS rpc(signature)
    WHERE has_function_privilege('authenticated', signature, 'EXECUTE')
  ),
  'authenticated users cannot execute CLI auth SECURITY DEFINER RPCs'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.consume_cli_auth_rate_limit(text,text,integer,integer)'),
      ('public.create_api_key_atomic(uuid,text,text)'),
      ('public.decide_cli_device_authorization(text,uuid,text)'),
      ('public.redeem_cli_device_authorization(text)'),
      ('public.validate_api_key_identity(text)'),
      ('public.revoke_current_api_key(text)'),
      ('public.cleanup_cli_device_authorizations()')
    ) AS rpc(signature)
    WHERE NOT has_function_privilege('service_role', signature, 'EXECUTE')
  ),
  'service role can execute every CLI auth RPC'
);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) VALUES (
  '00000000-0000-0000-0000-000000000981',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'cli-auth@example.test', '',
  now(), now(), now()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO public.cli_device_authorizations (
  device_code_hash, user_code_hash, site_origin, agent_label, expires_at
) VALUES (
  repeat('a', 64), repeat('b', 64), 'https://newsroom.example',
  'Codex CLI', now() + interval '10 minutes'
);

PREPARE anon_device_select AS
  SELECT count(*) FROM public.cli_device_authorizations;
SET LOCAL ROLE anon;
SELECT throws_ok('anon_device_select', '42501', NULL,
  'anon cannot inspect pending device requests');
RESET ROLE;

PREPARE direct_key_insert AS
  INSERT INTO public.api_keys(user_id, key_hash, key_prefix, name)
  VALUES (
    '00000000-0000-0000-0000-000000000981',
    repeat('c', 64), 'cj_directxx', 'bypass'
  );
SET LOCAL ROLE authenticated;
SELECT throws_ok('direct_key_insert', '42501', NULL,
  'authenticated users cannot bypass the API-key creation RPC');
RESET ROLE;

CREATE TEMP TABLE decision AS
SELECT * FROM public.decide_cli_device_authorization(
  repeat('b', 64),
  '00000000-0000-0000-0000-000000000981',
  'approve'
);
SELECT is((SELECT result FROM decision), 'approved',
  'a deliberate approval moves the request to approved');

CREATE TEMP TABLE redemption AS
SELECT * FROM public.redeem_cli_device_authorization(repeat('a', 64));
SELECT is((SELECT result FROM redemption), 'created',
  'first redemption creates a credential');
SELECT matches((SELECT api_key FROM redemption), '^cj_[A-Za-z0-9_-]{20,}$',
  'raw credential is returned in the successful transaction');
SELECT is(
  (SELECT count(*)::integer FROM public.api_keys
    WHERE device_authorization_id = (
      SELECT id FROM public.cli_device_authorizations
      WHERE device_code_hash = repeat('a', 64)
    )),
  1,
  'redemption inserts exactly one API key'
);
SELECT is(
  (SELECT key_hash FROM public.api_keys WHERE id = (SELECT key_id FROM redemption)),
  encode(digest((SELECT api_key FROM redemption), 'sha256'), 'hex'),
  'database stores only the credential hash'
);
SELECT isnt(
  (SELECT key_hash FROM public.api_keys WHERE id = (SELECT key_id FROM redemption)),
  (SELECT api_key FROM redemption),
  'raw credential is not persisted'
);

CREATE TEMP TABLE replay AS
SELECT * FROM public.redeem_cli_device_authorization(repeat('a', 64));
SELECT is((SELECT result FROM replay), 'invalid_grant',
  'redemption replay is terminal');
SELECT is((SELECT api_key FROM replay), NULL::text,
  'redemption replay never recovers the raw credential');
SELECT is(
  (SELECT count(*)::integer FROM public.api_keys
    WHERE device_authorization_id = (
      SELECT id FROM public.cli_device_authorizations
      WHERE device_code_hash = repeat('a', 64)
    )),
  1,
  'redemption replay creates no additional key'
);

CREATE TEMP TABLE identity AS
SELECT * FROM public.validate_api_key_identity((SELECT api_key FROM redemption));
SELECT is((SELECT user_id FROM identity),
  '00000000-0000-0000-0000-000000000981'::uuid,
  'credential identity resolves its owner');
SELECT is((SELECT key_id FROM identity), (SELECT key_id FROM redemption),
  'credential identity resolves the exact key');

SELECT lives_ok(
  $$SELECT public.create_api_key_atomic(
    '00000000-0000-0000-0000-000000000981', 'manual-2', 'manual'
  )$$,
  'manual creation uses the shared atomic RPC'
);
SELECT lives_ok(
  $$SELECT public.create_api_key_atomic(
    '00000000-0000-0000-0000-000000000981', 'manual-3', 'manual'
  )$$,
  'third key can be created'
);
SELECT lives_ok(
  $$SELECT public.create_api_key_atomic(
    '00000000-0000-0000-0000-000000000981', 'manual-4', 'manual'
  )$$,
  'fourth key can be created'
);
SELECT lives_ok(
  $$SELECT public.create_api_key_atomic(
    '00000000-0000-0000-0000-000000000981', 'manual-5', 'manual'
  )$$,
  'fifth key can be created'
);
CREATE TEMP TABLE limited AS
SELECT public.create_api_key_atomic(
  '00000000-0000-0000-0000-000000000981', 'manual-6', 'manual'
) AS payload;
SELECT is((SELECT payload->>'result' FROM limited), 'key_limit_reached',
  'database rejects a sixth API key');
SELECT is((SELECT count(*)::integer FROM public.api_keys
  WHERE user_id = '00000000-0000-0000-0000-000000000981'), 5,
  'five-key limit remains authoritative');

INSERT INTO public.cli_device_authorizations (
  device_code_hash, user_code_hash, site_origin, agent_label, expires_at
) VALUES (
  repeat('d', 64), repeat('e', 64), 'https://newsroom.example',
  'Denied CLI', now() + interval '10 minutes'
);
CREATE TEMP TABLE denied_decision AS
SELECT * FROM public.decide_cli_device_authorization(
  repeat('e', 64),
  '00000000-0000-0000-0000-000000000981',
  'deny'
);
SELECT is((SELECT result FROM denied_decision), 'denied',
  'explicit denial records a terminal decision');
CREATE TEMP TABLE denied_redemption AS
SELECT * FROM public.redeem_cli_device_authorization(repeat('d', 64));
SELECT is((SELECT result FROM denied_redemption), 'access_denied',
  'a denied request cannot be redeemed');
SELECT is((SELECT api_key FROM denied_redemption), NULL::text,
  'denial returns no raw API key');

INSERT INTO public.cli_device_authorizations (
  device_code_hash, user_code_hash, site_origin, agent_label,
  created_at, expires_at
) VALUES (
  repeat('1', 64), repeat('2', 64), 'https://newsroom.example',
  'Expired CLI', now() - interval '20 minutes', now() - interval '10 minutes'
);
CREATE TEMP TABLE expired_redemption AS
SELECT * FROM public.redeem_cli_device_authorization(repeat('1', 64));
SELECT is((SELECT result FROM expired_redemption), 'expired_token',
  'expired request redemption is rejected');
SELECT is(
  (SELECT status FROM public.cli_device_authorizations
    WHERE device_code_hash = repeat('1', 64)),
  'expired',
  'redemption records request expiry'
);
SELECT is((SELECT api_key FROM expired_redemption), NULL::text,
  'expiry returns no raw API key');

INSERT INTO public.cli_device_authorizations (
  device_code_hash, user_code_hash, site_origin, agent_label, expires_at
) VALUES (
  repeat('3', 64), repeat('4', 64), 'https://newsroom.example',
  'Limited CLI', now() + interval '10 minutes'
);
CREATE TEMP TABLE limited_decision AS
SELECT * FROM public.decide_cli_device_authorization(
  repeat('4', 64),
  '00000000-0000-0000-0000-000000000981',
  'approve'
);
SELECT is((SELECT result FROM limited_decision), 'key_limit_reached',
  'approval stops when the account already has five keys');
SELECT is(
  (SELECT status FROM public.cli_device_authorizations
    WHERE device_code_hash = repeat('3', 64)),
  'pending',
  'key-limit rejection does not silently approve the request'
);
SELECT is((SELECT count(*)::integer FROM public.api_keys
  WHERE user_id = '00000000-0000-0000-0000-000000000981'), 5,
  'key-limit approval creates no sixth key');

CREATE TEMP TABLE first_rate AS
SELECT * FROM public.consume_cli_auth_rate_limit(
  repeat('5', 64), 'test', 1, 60
);
CREATE TEMP TABLE second_rate AS
SELECT * FROM public.consume_cli_auth_rate_limit(
  repeat('5', 64), 'test', 1, 60
);
SELECT is((SELECT allowed FROM first_rate), true,
  'first request inside a rate window is allowed');
SELECT is((SELECT allowed FROM second_rate), false,
  'rate limit rejects attempts over the configured window limit');
SELECT is((SELECT attempts FROM second_rate), 2,
  'rate limiter records attempts atomically');

SELECT is(
  (SELECT count(*)::integer FROM cron.job WHERE jobname = 'cleanup-cli-device-auth'),
  1,
  'cleanup cron is registered'
);

SELECT * FROM finish();
ROLLBACK;
