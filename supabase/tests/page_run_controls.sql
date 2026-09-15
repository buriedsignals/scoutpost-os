BEGIN;
SELECT no_plan();

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000001341',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'page-replay@example.test', '', now(), now(), now()
);
INSERT INTO public.scouts (
  id, user_id, name, type, url, criteria, is_active, schedule_cron
) VALUES (
  '00000000-0000-4000-8000-000000001342',
  '00000000-0000-4000-8000-000000001341',
  'Paused original', 'web', 'https://example.org/original', 'Report changes', false, '1 8 * * *'
);
INSERT INTO public.credit_accounts (user_id, tier, monthly_cap, balance, entitlement_source)
VALUES ('00000000-0000-4000-8000-000000001341', 'pro', 10, 10, 'cojournalist-pro');

CREATE FUNCTION pg_temp.replay(
  p_apply boolean DEFAULT false, p_snapshot jsonb DEFAULT NULL, p_cost int DEFAULT NULL
) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.prepare_page_scout_replay(
    '00000000-0000-4000-8000-000000001342',
    '00000000-0000-4000-8000-000000001343', p_apply, p_snapshot, p_cost
  );
$$;
CREATE TEMP TABLE preview AS SELECT pg_temp.replay() AS result;
SELECT is((SELECT count(*) FROM public.scout_runs WHERE scout_id = '00000000-0000-4000-8000-000000001342'),
  0::bigint, 'preview does not create a run');
SELECT is((SELECT count(*) FROM public.scout_dispatch_queue WHERE scout_id = '00000000-0000-4000-8000-000000001342'),
  0::bigint, 'preview does not enqueue work');
SELECT is((SELECT balance FROM public.credit_accounts WHERE user_id = '00000000-0000-4000-8000-000000001341'),
  10, 'preview does not charge');
SELECT is((SELECT result->'snapshot'->'scout'->>'url' FROM preview),
  'https://example.org/original', 'approval captures the original monitored URL');
SELECT throws_ok($$SELECT pg_temp.replay(true)$$, 'P0001', NULL,
  'apply without a preview and explicit credit approval is rejected');
SELECT throws_ok($$SELECT pg_temp.replay(true, (SELECT result->'snapshot' FROM preview), 2)$$,
  'P0001', NULL, 'apply does not accept a different approved price');
UPDATE public.scouts SET criteria = 'Changed after preview' WHERE id = '00000000-0000-4000-8000-000000001342';
SELECT throws_ok($$SELECT pg_temp.replay(true, (SELECT result->'snapshot' FROM preview), 1)$$,
  'P0001', NULL, 'stale approval cannot enqueue changed monitored inputs');
UPDATE public.scouts SET criteria = 'Report changes', is_active = true WHERE id = '00000000-0000-4000-8000-000000001342';
SELECT throws_ok($$SELECT pg_temp.replay()$$, 'P0001', NULL, 'operator replay requires a paused Scout');
UPDATE public.scouts SET is_active = false WHERE id = '00000000-0000-4000-8000-000000001342';
UPDATE preview SET result = pg_temp.replay();
SELECT is(pg_temp.replay(true, (SELECT result->'snapshot' FROM preview), 1)->>'created',
  'true', 'approved apply creates the fixed run');
SELECT is((SELECT count(*) FROM public.scout_dispatch_queue WHERE scout_id = '00000000-0000-4000-8000-000000001342'),
  1::bigint, 'approved apply admits one dispatch');
SELECT is((SELECT to_jsonb(s) FROM public.scouts s WHERE id = '00000000-0000-4000-8000-000000001342'),
  (SELECT result->'snapshot'->'scout' FROM preview), 'apply preserves the entire Scout configuration and paused state');
SELECT is((SELECT balance FROM public.credit_accounts WHERE user_id = '00000000-0000-4000-8000-000000001341'),
  10, 'admission leaves charging to the normal executor');
SELECT is(pg_temp.replay(true, (SELECT result->'snapshot' FROM preview), 1)->>'created',
  'false', 'uncertain apply can safely reconnect to the original run');
SELECT is((SELECT count(*) FROM public.scout_runs WHERE scout_id = '00000000-0000-4000-8000-000000001342'),
  1::bigint, 'retry does not create a second run');
SELECT throws_ok($$SELECT pg_temp.replay(true, '{}'::jsonb, 1)$$, 'P0001', NULL,
  'an existing replay ID cannot be reused for a different approval');
SELECT throws_ok($$SELECT public.prepare_page_scout_replay(
  '00000000-0000-4000-8000-000000001342', '00000000-0000-4000-8000-000000001344')$$,
  'P0001', NULL, 'another run cannot be previewed while the original dispatch is active');
SELECT is(public.bind_page_scout_notification_mode(
  '00000000-0000-4000-8000-000000001343', '00000000-0000-4000-8000-000000001342', 'deliver'),
  'disabled', 'a retry cannot enable delivery on the replay');

CREATE TEMP TABLE first_lease AS SELECT * FROM public.claim_page_workflow_run(
  '00000000-0000-4000-8000-000000001343', 300);
SELECT is((SELECT count(*) FROM public.claim_page_workflow_run(
  '00000000-0000-4000-8000-000000001343', 300)), 0::bigint, 'a live lease excludes competing workflow workers');
SELECT ok(public.set_page_workflow_stage(
  '00000000-0000-4000-8000-000000001343', (SELECT lease_token FROM first_lease), 'waiting_children', true),
  'waiting for child retrieval yields its workflow lease');
CREATE TEMP TABLE next_lease AS SELECT * FROM public.claim_page_workflow_run(
  '00000000-0000-4000-8000-000000001343', 300);
SELECT isnt((SELECT lease_token FROM next_lease), (SELECT lease_token FROM first_lease),
  'continuation receives a different ownership token');
SELECT is((SELECT page_notification_mode FROM public.scout_runs WHERE id = '00000000-0000-4000-8000-000000001343'),
  'disabled', 'continuation retains durable notification suppression');
INSERT INTO public.scout_runs (id, scout_id, user_id, status)
VALUES ('00000000-0000-4000-8000-000000001345',
  '00000000-0000-4000-8000-000000001342', '00000000-0000-4000-8000-000000001341', 'running');
SELECT is(public.bind_page_scout_notification_mode(
  '00000000-0000-4000-8000-000000001345', '00000000-0000-4000-8000-000000001342', 'deliver'),
  'deliver', 'a normal Page run binds its initial delivery policy');
SELECT is(public.bind_page_scout_notification_mode(
  '00000000-0000-4000-8000-000000001345', '00000000-0000-4000-8000-000000001342', 'disabled'),
  'deliver', 'a later request cannot change the bound delivery policy');
SELECT ok(bool_and(NOT has_function_privilege('authenticated', signature, 'EXECUTE')),
  'customer sessions cannot access replay or notification binding')
FROM (VALUES
  ('public.prepare_page_scout_replay(uuid,uuid,boolean,jsonb,integer)'),
  ('public.bind_page_scout_notification_mode(uuid,uuid,text)')
) AS guarded(signature);
SELECT * FROM finish();
ROLLBACK;
