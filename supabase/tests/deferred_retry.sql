BEGIN;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

SELECT ok(NOT has_function_privilege('authenticated', 'public.enqueue_scout_dispatch(uuid,uuid,text,integer,text,timestamptz,uuid)', 'EXECUTE'), 'customers cannot enqueue dispatches');
SELECT ok(has_function_privilege('service_role', 'public.enqueue_scout_dispatch(uuid,uuid,text,integer,text,timestamptz,uuid)', 'EXECUTE'), 'service enqueues dispatches');

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000991',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'deferred-retry@example.test', '',
  now(), now(), now()
);
INSERT INTO public.scouts (id, user_id, name, type, is_active, schedule_cron) VALUES
  ('00000000-0000-4000-8000-000000000992', '00000000-0000-4000-8000-000000000991', 'Retry Web', 'web', true, '6 8 * * *');

-- A scheduled run that failed on retrieval.
CREATE TEMP TABLE original AS
SELECT * FROM public.enqueue_scout_dispatch('00000000-0000-4000-8000-000000000992', NULL, 'scheduled', 0);
UPDATE public.scout_dispatch_queue SET status = 'failed', completed_at = now()
 WHERE scout_run_id = (SELECT run_id FROM original);
UPDATE public.scout_runs SET status = 'error', completed_at = now(),
       error_message = 'firecrawl scrape failed: 408 {"code":"SCRAPE_TIMEOUT"}'
 WHERE id = (SELECT run_id FROM original);

-- Deferred retry: a new run, queued for later, linked to the original.
CREATE TEMP TABLE retry AS
SELECT * FROM public.enqueue_scout_dispatch(
  '00000000-0000-4000-8000-000000000992', NULL, 'deferred_retry', 0, 'service',
  now() + interval '45 minutes', (SELECT run_id FROM original));
SELECT ok((SELECT enqueued FROM retry), 'deferred retry enqueues');
SELECT isnt((SELECT run_id FROM retry), (SELECT run_id FROM original), 'deferred retry is a fresh run');
SELECT is((SELECT metadata->>'dispatch_source' FROM public.scout_runs WHERE id = (SELECT run_id FROM retry)), 'deferred_retry', 'retry run records its source');
SELECT is((SELECT (metadata->>'deferred_retry_of')::uuid FROM public.scout_runs WHERE id = (SELECT run_id FROM retry)), (SELECT run_id FROM original), 'retry run links to the original');
SELECT is((SELECT source FROM public.scout_dispatch_queue WHERE scout_run_id = (SELECT run_id FROM retry)), 'deferred_retry', 'queue row records the source');
SELECT ok((SELECT scheduled_for FROM public.scout_dispatch_queue WHERE scout_run_id = (SELECT run_id FROM retry)) > now() + interval '44 minutes', 'retry waits for its slot');

-- The drain must not claim it before its slot.
SELECT is((SELECT count(*) FROM public.claim_scout_dispatch_batch('worker-retry', 3, 3, 900, 3)), 0::bigint, 'a future retry is not claimable now');

-- Idempotent: the same original never gets a second retry.
CREATE TEMP TABLE retry_again AS
SELECT * FROM public.enqueue_scout_dispatch(
  '00000000-0000-4000-8000-000000000992', NULL, 'deferred_retry', 0, 'service',
  now() + interval '45 minutes', (SELECT run_id FROM original));
SELECT is((SELECT enqueued FROM retry_again), false, 'second deferral is refused');
SELECT is((SELECT run_id FROM retry_again), (SELECT run_id FROM retry), 'second deferral returns the existing retry');

-- Guards.
SELECT throws_ok(
  $$ SELECT public.enqueue_scout_dispatch('00000000-0000-4000-8000-000000000992', NULL, 'deferred_retry', 0, 'service', now(), NULL) $$,
  'deferred retry needs the failed run and creates its own');
SELECT throws_ok(
  format($$ SELECT public.enqueue_scout_dispatch('00000000-0000-4000-8000-000000000992', NULL, 'deferred_retry', 0, 'service', now(), %L) $$,
    (SELECT run_id FROM retry)),
  'deferred retry requires a failed scheduled run');
SELECT throws_ok(
  format($$ SELECT public.enqueue_scout_dispatch('00000000-0000-4000-8000-000000000992', NULL, 'scheduled', 0, 'service', now(), %L) $$,
    (SELECT run_id FROM original)),
  'p_retry_of is only valid for deferred retries');

-- Ordinary enqueue is unchanged.
UPDATE public.scout_dispatch_queue SET status = 'failed', completed_at = now()
 WHERE scout_run_id = (SELECT run_id FROM retry);
CREATE TEMP TABLE plain AS
SELECT * FROM public.enqueue_scout_dispatch('00000000-0000-4000-8000-000000000992', NULL, 'manual', 100);
SELECT ok((SELECT enqueued FROM plain), 'manual enqueue still works');
SELECT ok((SELECT scheduled_for FROM public.scout_dispatch_queue WHERE scout_run_id = (SELECT run_id FROM plain)) <= now(), 'manual enqueue is immediate');

SELECT * FROM finish();
ROLLBACK;
