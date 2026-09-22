BEGIN;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

-- Access: service-only memory, no customer or anonymous reach.
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.scrape_host_policy'::regclass), 'host policy RLS enabled');
SELECT ok(NOT has_table_privilege('anon', 'public.scrape_host_policy', 'SELECT'), 'anonymous cannot read host policy');
SELECT ok(NOT has_table_privilege('authenticated', 'public.scrape_host_policy', 'SELECT'), 'customers cannot read host policy');
SELECT ok(has_table_privilege('service_role', 'public.scrape_host_policy', 'SELECT'), 'service reads host policy');
SELECT ok(NOT has_function_privilege('authenticated', 'public.record_scrape_host_block(text,text)', 'EXECUTE'), 'customers cannot record blocks');
SELECT ok(has_function_privilege('service_role', 'public.record_scrape_host_block(text,text)', 'EXECUTE'), 'service records blocks');
SELECT ok(has_function_privilege('service_role', 'public.clear_scrape_host_block(text)', 'EXECUTE'), 'service clears blocks');
SELECT ok(NOT has_function_privilege('authenticated', 'public.enqueue_crawler_job(text,text,text,text,text,text,text,jsonb,integer,integer,uuid,uuid,uuid,text)', 'EXECUTE'), 'customers cannot enqueue routed crawler jobs');

-- Evidence: two rescues within seven days enforce for fourteen; timeouts count.
DELETE FROM public.scrape_host_policy;
SELECT is((public.record_scrape_host_block('www.mardigras.org.au')).evidence_count, 1, 'first rescue records evidence');
SELECT is((SELECT expires_at FROM public.scrape_host_policy WHERE host = 'www.mardigras.org.au'), NULL::timestamptz, 'one rescue does not enforce');
SELECT ok((public.record_scrape_host_block('www.mardigras.org.au', 'timeout')).expires_at BETWEEN now() + interval '13 days 23 hours' AND now() + interval '14 days 1 hour', 'second rescue, a timeout, enforces for fourteen days');
SELECT is((SELECT reason FROM public.scrape_host_policy WHERE host = 'www.mardigras.org.au'), 'timeout', 'latest reason is recorded');
SELECT is((SELECT count(*)::int FROM public.scrape_host_policy WHERE expires_at > now()), 1, 'one enforced host');
SELECT is((public.record_scrape_host_block('www.npcc.police.uk', 'timeout')).evidence_count, 1, 'a timeout can be the first evidence');

-- Decay: evidence older than seven days restarts the count.
UPDATE public.scrape_host_policy SET last_seen_at = now() - interval '8 days', expires_at = NULL, evidence_count = 1 WHERE host = 'www.mardigras.org.au';
SELECT is((public.record_scrape_host_block('www.mardigras.org.au')).evidence_count, 1, 'stale evidence restarts at one');

-- Validation and clearing.
SELECT throws_ok($$ SELECT public.record_scrape_host_block('Bad Host') $$, 'invalid scrape host');
SELECT throws_ok($$ SELECT public.record_scrape_host_block('example.test', 'dns') $$, 'unsupported scrape host block reason');
SELECT is(public.clear_scrape_host_block('www.mardigras.org.au'), true, 'clear removes the row');
SELECT is(public.clear_scrape_host_block('www.mardigras.org.au'), false, 'clearing an absent host is a no-op');

-- Durable routing: a blocked host is inserted already in fallback_required
-- with the same bookkeeping the worker writes for an anti-bot block. The
-- proxy kind is used here because scout_run rows require live scout context.
DELETE FROM public.crawler_jobs;
CREATE TEMP TABLE routed AS
  SELECT * FROM public.enqueue_crawler_job(
    'host-policy:routed', 'proxy', 'tenant', 'run', 'scrape', 'root',
    'https://www.mardigras.org.au/', '{"timeout_ms": 25000, "host_policy": "firecrawl"}'::jsonb,
    0, 3, NULL, NULL, NULL, 'anti_bot');
SELECT is((SELECT status FROM routed), 'fallback_required', 'routed job skips the worker');
SELECT is((SELECT error_class FROM routed), 'anti_bot', 'routed job carries the anti-bot class');
SELECT is((SELECT error_message FROM routed), 'host policy: primary renderer blocked by anti-bot protection', 'routed job explains itself');
SELECT ok((SELECT completed_at IS NOT NULL FROM routed), 'routed job is completed like a worker-reported block');
SELECT is((SELECT status FROM public.enqueue_crawler_job(
    'host-policy:plain', 'proxy', 'tenant', 'run', 'scrape', 'child',
    'https://example.test/', '{}'::jsonb)), 'queued', 'default enqueue is unchanged');
SELECT throws_ok($$ SELECT public.enqueue_crawler_job(
    'host-policy:bad', 'proxy', 'tenant', 'run', 'parse_pdf', 'root',
    'https://example.test/a.pdf', '{}'::jsonb, 0, 3, NULL, NULL, NULL, 'anti_bot') $$,
  'invalid crawler fallback routing');

-- Operators see the count of enforced hosts.
SELECT ok((public.crawler_operations_observation()) ? 'blocked_hosts', 'observation exposes blocked_hosts');

SELECT * FROM finish();
ROLLBACK;
