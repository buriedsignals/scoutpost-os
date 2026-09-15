BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(36);

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000001351', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'page-cancellation@example.test', '', now(), now(), now());
INSERT INTO public.scouts (id, user_id, name, type, url, is_active, schedule_cron)
VALUES ('00000000-0000-4000-8000-000000001352', '00000000-0000-4000-8000-000000001351',
  'Cancellation Page', 'web', 'https://example.test', false, '1 8 * * *');
CREATE TEMP TABLE parents (label text PRIMARY KEY, id uuid DEFAULT gen_random_uuid());
INSERT INTO parents (label) VALUES ('success'), ('error'), ('skipped'), ('running'), ('leased'), ('claim_wins'), ('expired');
INSERT INTO public.scout_runs (id, scout_id, user_id, status, crawler_backend, metadata)
SELECT id, '00000000-0000-4000-8000-000000001352', '00000000-0000-4000-8000-000000001351',
  CASE WHEN label IN ('success', 'error', 'skipped') THEN label WHEN label = 'leased' THEN 'error' ELSE 'running' END,
  'workflow', '{"coverage":{"checked":0,"failed":1,"complete":false}}'::jsonb
FROM parents;
UPDATE public.scout_runs SET workflow_lease_token = gen_random_uuid(), workflow_lease_expires_at = now() + interval '5 minutes'
WHERE id = (SELECT id FROM parents WHERE label = 'leased');

INSERT INTO public.crawler_jobs (dedupe_key, request_kind, tenant_key, continuation_key, scout_run_id, scout_id, user_id,
  operation, pipeline_stage, url, status, attempts, error_class, error_message, result_manifest, completed_at)
SELECT 'cancel:' || p.label || ':' || state, 'scout_run', 'tenant', p.id::text, p.id,
  '00000000-0000-4000-8000-000000001352', '00000000-0000-4000-8000-000000001351',
  'scrape', 'child:test', 'https://example.test/child', state, 1, 'anti_bot', 'original challenge',
  CASE WHEN state = 'succeeded' THEN '{"execution_id":"committed","artifacts":[]}'::jsonb ELSE NULL END,
  CASE WHEN state IN ('fallback_required', 'terminal_failed', 'succeeded') THEN now() - interval '1 minute' ELSE NULL END
FROM parents p CROSS JOIN unnest(ARRAY['queued', 'batched', 'retryable_failed', 'fallback_required', 'succeeded', 'terminal_failed']) state
WHERE p.label IN ('success', 'error', 'skipped', 'running', 'leased');

CREATE TEMP TABLE health_before AS SELECT terminal_failed_recent FROM public.crawler_operations_health();
CREATE TEMP TABLE preview AS SELECT * FROM public.cancel_terminal_page_crawler_jobs((SELECT id FROM parents WHERE label = 'success'), 2, false);
SELECT is((SELECT count(*) FROM preview), 2::bigint, 'preview is bounded');
SELECT ok(NOT EXISTS (SELECT 1 FROM preview WHERE applied), 'preview identifies unapplied rows');
SELECT is((SELECT count(*) FROM public.crawler_jobs WHERE status = 'cancelled'), 0::bigint, 'preview is read-only');
CREATE TEMP TABLE applied AS SELECT * FROM public.cancel_terminal_page_crawler_jobs((SELECT id FROM parents WHERE label = 'success'), 2, true);
SELECT is((SELECT count(*) FROM applied), 2::bigint, 'apply obeys the requested bound');
SELECT is((SELECT count(*) FROM public.cancel_terminal_page_crawler_jobs((SELECT id FROM parents WHERE label = 'success'), 500, true)), 2::bigint, 'second bounded apply collects only remaining eligible work');
SELECT is((SELECT count(*) FROM public.cancel_terminal_page_crawler_jobs((SELECT id FROM parents WHERE label = 'success'), 500, true)), 0::bigint, 'repeat cleanup is a no-op');
SELECT is((SELECT count(*) FROM public.cancel_terminal_page_crawler_jobs((SELECT id FROM parents WHERE label = 'error'), 500, true)), 4::bigint, 'error parents close unused work');
SELECT is((SELECT count(*) FROM public.cancel_terminal_page_crawler_jobs((SELECT id FROM parents WHERE label = 'skipped'), 500, true)), 4::bigint, 'skipped parents close unused work');
SELECT is((SELECT count(*) FROM public.cancel_terminal_page_crawler_jobs((SELECT id FROM parents WHERE label = 'running'), 500, true)), 0::bigint, 'running parents are untouched');
SELECT is((SELECT count(*) FROM public.cancel_terminal_page_crawler_jobs((SELECT id FROM parents WHERE label = 'leased'), 500, true)), 0::bigint, 'live parent leases are untouched');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.crawler_jobs WHERE status = 'cancelled' AND
  (error_message <> 'original challenge' OR error_class <> 'anti_bot' OR attempts <> 1 OR scout_run_id IS NULL OR cancellation_reason <> 'parent_run_terminal' OR cancelled_at IS NULL)),
  'cancellation preserves failure evidence and records a distinct reason and parent');
SELECT is((SELECT metadata FROM public.scout_runs WHERE id = (SELECT id FROM parents WHERE label = 'success')),
  '{"coverage":{"checked":0,"failed":1,"complete":false}}'::jsonb, 'cancellation does not turn incomplete parent coverage into success');
SELECT is((SELECT terminal_failed_recent FROM public.crawler_operations_health()),
  (SELECT terminal_failed_recent FROM health_before), 'cancelled work adds no retrieval failures and keeps genuine failures counted');
SELECT is((SELECT result_manifest ->> 'execution_id' FROM public.crawler_jobs WHERE dedupe_key = 'cancel:success:succeeded'), 'committed', 'committed results are not overwritten');
SELECT ok(NOT public.complete_crawler_job((SELECT id FROM public.crawler_jobs WHERE dedupe_key = 'cancel:success:queued'), gen_random_uuid(), true, '{"artifacts":[]}'::jsonb), 'late native completion cannot overwrite cancellation');
SELECT ok(NOT public.complete_crawler_fallback((SELECT id FROM public.crawler_jobs WHERE dedupe_key = 'cancel:success:fallback_required'), true, '{"artifacts":[]}'::jsonb, NULL, gen_random_uuid()), 'cancellation wins against a late fallback completion');
SELECT is(public.claim_page_crawler_fallback((SELECT id FROM public.crawler_jobs WHERE dedupe_key = 'cancel:success:fallback_required')), NULL::uuid, 'cancelled fallback cannot start provider work');

INSERT INTO public.crawler_jobs (dedupe_key, request_kind, tenant_key, continuation_key, scout_run_id, scout_id, user_id, operation, pipeline_stage, url, status, error_class, error_message)
SELECT 'cancel:' || label, 'scout_run', 'tenant', id::text, id,
  '00000000-0000-4000-8000-000000001352', '00000000-0000-4000-8000-000000001351',
  'scrape', 'root', 'https://example.test', 'fallback_required', 'anti_bot', 'original challenge'
FROM parents WHERE label IN ('claim_wins', 'expired');
CREATE TEMP TABLE fallback_claim AS SELECT public.claim_page_crawler_fallback((SELECT id FROM public.crawler_jobs WHERE dedupe_key = 'cancel:claim_wins')) AS token;
SELECT ok((SELECT token IS NOT NULL FROM fallback_claim), 'active Page parent permits one durable fallback claim');
SELECT is(public.claim_page_crawler_fallback((SELECT id FROM public.crawler_jobs WHERE dedupe_key = 'cancel:claim_wins')), NULL::uuid, 'duplicate callers cannot start a second provider attempt');
UPDATE public.scout_runs SET status = 'error' WHERE id = (SELECT id FROM parents WHERE label = 'claim_wins');
SELECT is((SELECT count(*) FROM public.cancel_terminal_page_crawler_jobs((SELECT id FROM parents WHERE label = 'claim_wins'), 100, true)), 0::bigint, 'claim winner remains active even after its parent terminates');
SELECT ok(public.complete_crawler_fallback((SELECT id FROM public.crawler_jobs WHERE dedupe_key = 'cancel:claim_wins'), true, '{"execution_id":"winner","artifacts":[]}'::jsonb, NULL, (SELECT token FROM fallback_claim)), 'claim winner can commit its actual retrieval result');
SELECT ok((SELECT status = 'succeeded' AND lease_token IS NULL AND lease_expires_at IS NULL FROM public.crawler_jobs WHERE dedupe_key = 'cancel:claim_wins'), 'fallback completion atomically releases its lease');
SELECT ok(NOT public.complete_crawler_fallback((SELECT id FROM public.crawler_jobs WHERE dedupe_key = 'cancel:claim_wins'), false, NULL, 'late failure', (SELECT token FROM fallback_claim)), 'losing completion cannot overwrite committed fallback');

CREATE TEMP TABLE expired_claim AS SELECT public.claim_page_crawler_fallback((SELECT id FROM public.crawler_jobs WHERE dedupe_key = 'cancel:expired')) AS token;
UPDATE public.crawler_jobs SET lease_expires_at = now() - interval '1 second' WHERE dedupe_key = 'cancel:expired';
DO $$ BEGIN PERFORM public.reconcile_crawler_jobs(); END $$;
SELECT ok((SELECT status = 'terminal_failed' AND error_message LIKE '%original challenge%' AND lease_token IS NULL FROM public.crawler_jobs WHERE dedupe_key = 'cancel:expired'), 'expired provider attempt is an honest failure retaining primary error evidence');
SELECT is(public.claim_page_crawler_fallback((SELECT id FROM public.crawler_jobs WHERE dedupe_key = 'cancel:expired')), NULL::uuid, 'expired provider attempt cannot be spent again');
UPDATE public.scout_runs SET workflow_lease_token = NULL, workflow_lease_expires_at = NULL WHERE id = (SELECT id FROM parents WHERE label = 'leased');
DO $$ BEGIN PERFORM public.reconcile_crawler_jobs(); END $$;
SELECT is((SELECT count(*) FROM public.crawler_jobs WHERE scout_run_id = (SELECT id FROM parents WHERE label = 'leased') AND status = 'cancelled'), 0::bigint, 'old dispatchers cannot activate cancellation by applying the migration');
DO $$ BEGIN PERFORM public.reconcile_crawler_jobs(true); END $$;
SELECT is((SELECT count(*) FROM public.crawler_jobs WHERE scout_run_id = (SELECT id FROM parents WHERE label = 'leased') AND status = 'cancelled'), 4::bigint, 'periodic reconciliation collects a missed finalizer after lease release');
SELECT ok(NOT has_function_privilege('authenticated', 'public.cancel_terminal_page_crawler_jobs(uuid,integer,boolean)', 'EXECUTE'), 'customer callers cannot cancel crawler jobs');
SELECT is((SELECT is_active FROM public.scouts WHERE id = '00000000-0000-4000-8000-000000001352'), false, 'cleanup leaves paused schedules paused');

INSERT INTO public.crawler_jobs (dedupe_key, request_kind, tenant_key, continuation_key, scout_run_id, scout_id, user_id,
  operation, pipeline_stage, url, status, lease_token, lease_expires_at)
SELECT 'cancel:active-worker', 'scout_run', 'tenant', id::text, id,
  '00000000-0000-4000-8000-000000001352', '00000000-0000-4000-8000-000000001351',
  'scrape', 'child:active', 'https://example.test/active', 'running', gen_random_uuid(), now() + interval '10 minutes'
FROM parents WHERE label = 'error';
SELECT is((SELECT count(*) FROM public.cancel_terminal_page_crawler_jobs((SELECT id FROM parents WHERE label = 'error'), 100, true)), 0::bigint, 'active renderer lease is never cancelled');
SELECT ok(public.complete_crawler_job((SELECT id FROM public.crawler_jobs WHERE dedupe_key = 'cancel:active-worker'),
  (SELECT lease_token FROM public.crawler_jobs WHERE dedupe_key = 'cancel:active-worker'), true, '{"artifacts":[]}'::jsonb),
  'active renderer can commit its real result after parent termination');
INSERT INTO public.crawler_jobs (dedupe_key, request_kind, tenant_key, continuation_key, operation, pipeline_stage, url, status)
VALUES ('cancel:proxy', 'proxy', 'tenant', 'proxy-request', 'scrape', 'proxy_scrape', 'https://example.test/proxy', 'fallback_required');
DO $$ BEGIN PERFORM public.cancel_terminal_page_crawler_jobs(NULL, 500, true); END $$;
SELECT is((SELECT status FROM public.crawler_jobs WHERE dedupe_key = 'cancel:proxy'), 'fallback_required', 'native Page cleanup does not touch proxy ownership');
SELECT ok(public.complete_crawler_fallback((SELECT id FROM public.crawler_jobs WHERE dedupe_key = 'cancel:proxy'), false, NULL, 'anti-bot fallback delegated to scrape caller'), 'existing proxy delegation remains compatible without a native token');
SELECT is((SELECT terminal_failed_recent FROM public.crawler_operations_health()),
  (SELECT terminal_failed_recent + 1 FROM health_before), 'the expired actual provider attempt remains a genuine health failure');

INSERT INTO public.crawler_batches (id, operation, status)
VALUES ('00000000-0000-4000-8000-000000001355', 'scrape', 'pending');
INSERT INTO public.crawler_jobs (
  dedupe_key, request_kind, tenant_key, continuation_key, scout_run_id, scout_id, user_id,
  batch_id, operation, pipeline_stage, url, status
)
SELECT 'cancel:delayed-batch', 'scout_run', 'tenant', id::text, id,
  '00000000-0000-4000-8000-000000001352', '00000000-0000-4000-8000-000000001351',
  '00000000-0000-4000-8000-000000001355', 'scrape', 'child:delayed', 'https://example.test/delayed', 'batched'
FROM parents WHERE label = 'error';
SELECT is((SELECT count(*) FROM public.claim_crawler_batch('00000000-0000-4000-8000-000000001355')),
  0::bigint, 'a delayed worker cannot newly claim work after its Page parent has terminated');
SELECT is((SELECT count(*) FROM public.cancel_terminal_page_crawler_jobs((SELECT id FROM parents WHERE label = 'error'), 100, true)),
  1::bigint, 'the missed finalizer can still cancel the unleased delayed batch');

SELECT * FROM finish();
ROLLBACK;
