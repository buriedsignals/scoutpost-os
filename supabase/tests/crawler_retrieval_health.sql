BEGIN;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

SELECT ok(NOT has_function_privilege('anon', 'public.crawler_operations_observation()', 'EXECUTE'), 'anonymous cannot read crawler health');
SELECT ok(NOT has_function_privilege('authenticated', 'public.crawler_operations_observation()', 'EXECUTE'), 'customers cannot read operator health');
SELECT ok(has_function_privilege('service_role', 'public.crawler_operations_observation()', 'EXECUTE'), 'service can read operator health');
SELECT ok(to_regprocedure('public.crawler_operations_health()') IS NOT NULL, 'old health contract remains available');
SELECT ok(NOT has_function_privilege('anon', 'public.crawler_retrieval_failure_category(text,text)', 'EXECUTE'), 'anonymous cannot execute classifier');
SELECT ok(NOT has_function_privilege('authenticated', 'public.record_operator_incident(text,text,boolean,text,text,jsonb,integer)', 'EXECUTE'), 'incident writer remains service-only');
SELECT ok(has_function_privilege('service_role', 'public.record_operator_incident(text,text,boolean,text,text,jsonb,integer)', 'EXECUTE'), 'service retains incident writer grant');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.operator_incidents'::regclass), 'incident RLS remains enabled');
SELECT is(public.crawler_retrieval_failure_category('fallback_terminal', 'firecrawl scrape failed: 408 {"code": "SCRAPE_TIMEOUT"}'), 'retrieval_timeout', 'provider JSON whitespace does not change classification');
SELECT is(public.crawler_retrieval_failure_category('fallback_terminal', 'firecrawl scrape failed: 500 {"code":"SCRAPE_TIMEOUT"}'), NULL::text, 'unrecognized provider failures remain workflow-visible');

-- Isolate fixtures inside this rolled-back transaction.
DELETE FROM public.crawler_jobs;
INSERT INTO public.crawler_jobs (dedupe_key, request_kind, tenant_key, continuation_key,
  operation, pipeline_stage, url, status, error_class, error_message, completed_at)
SELECT 'health-v2:' || label, 'proxy', 'health-v2', label, operation, 'fetch',
  'https://private:secret@example.test/private?token=secret', 'terminal_failed', error_class, error_message, now()
FROM (VALUES
  ('abandoned', 'scrape', 'fallback_terminal', 'crawler proxy caller no longer waiting'),
  ('crawl-timeout', 'scrape', 'timeout', 'crawl timed out'),
  ('provider-timeout', 'scrape', 'fallback_terminal', 'firecrawl scrape failed: 408 {"code":"SCRAPE_TIMEOUT"}'),
  ('navigation', 'scrape', 'retryable', 'Page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://example.test'),
  ('storage', 'scrape', 'retryable', 'upload timeout'),
  ('callback', 'scrape', 'fallback_terminal', 'fallback completion rejected'),
  ('provider-auth', 'scrape', 'fallback_terminal', 'firecrawl scrape failed: 401 unauthorized'),
  ('unknown', 'scrape', NULL, NULL),
  ('delegated', 'scrape', 'fallback_terminal', 'anti-bot fallback delegated to scrape caller'),
  ('delegated-timeout', 'scrape', 'fallback_terminal', 'timeout-exhausted fallback delegated to scrape caller'),
  ('dns', 'scrape', 'terminal', 'download failed: cannot resolve example.test'),
  ('not-pdf', 'parse_pdf', 'terminal', 'not_a_pdf')
) AS fixture(label, operation, error_class, error_message);

CREATE TEMP TABLE health_v2 AS SELECT public.crawler_operations_observation() AS value;
SELECT is((SELECT (value->>'terminal_failed_recent')::int FROM health_v2), 8, 'established exclusions preserved; unknown NULL errors count');
SELECT is((SELECT (value->>'retrieval_failed_recent')::int FROM health_v2), 4, 'only recognized retrieval failures are separated');
SELECT is((SELECT (value->>'workflow_failed_recent')::int FROM health_v2), 4, 'storage, callbacks, auth and unknown failures retain workflow alert');
SELECT is((SELECT (value->>'caller_abandoned_recent')::int FROM health_v2), 1, 'abandoned caller identified separately');
SELECT is((SELECT (value->>'window_seconds')::int FROM health_v2), 3600, 'one-hour failure window retained');
SELECT ok((SELECT value->>'observed_at' IS NOT NULL FROM health_v2), 'observation includes database timestamp');
SELECT ok((SELECT (value->'retrieval_groups')::text NOT LIKE '%secret%' FROM health_v2), 'credentials and query tokens excluded');
SELECT ok((SELECT (value->'retrieval_groups')::text NOT LIKE '%/private%' FROM health_v2), 'paths excluded');
SELECT is((SELECT value->'retrieval_groups'->0->>'hostname' FROM health_v2), 'example.test', 'requested hostname retained');

INSERT INTO public.crawler_jobs (dedupe_key, request_kind, tenant_key, continuation_key,
  operation, pipeline_stage, url, status, updated_at)
VALUES ('health-v2:batched', 'proxy', 'health-v2', 'batched', 'scrape', 'fetch', 'https://example.test', 'batched', now() - interval '15 minutes');
SELECT is((public.crawler_operations_observation()->>'dispatch_eligible')::int, 0, 'no queued work');
SELECT is((public.crawler_operations_observation()->>'batched_waiting')::int, 1, 'batched work remains visible');
SELECT ok((public.crawler_operations_observation()->>'oldest_wait_seconds')::numeric >= 900, 'batched age is preserved');

UPDATE public.crawler_jobs SET completed_at = now() - interval '2 hours' WHERE dedupe_key LIKE 'health-v2:%';
SELECT is((public.crawler_operations_observation()->>'terminal_failed_recent')::int, 0, 'old terminal outcomes age out');

SELECT is((SELECT transition FROM public.record_operator_incident('test-retrieval', 'crawler_retrieval_failures', true, 'warning', 'test')), 'opened', 'retrieval incident kind can open');
SELECT public.ack_operator_incident_notifications(ARRAY['test-retrieval']);
SELECT is((SELECT should_notify FROM public.record_operator_incident('test-retrieval', 'crawler_retrieval_failures', true, 'warning', 'test')), false, 'retrieval incident deduplicates');
SELECT is((SELECT should_notify FROM public.record_operator_incident('test-retrieval', 'crawler_retrieval_failures', true, 'critical', 'escalated')), true, 'critical escalation bypasses reminder cooldown');
SELECT public.ack_operator_incident_notifications(ARRAY['test-retrieval']);
SELECT is((SELECT should_notify FROM public.record_operator_incident('test-retrieval', 'crawler_retrieval_failures', true, 'critical', 'escalated')), false, 'acknowledged critical escalation deduplicates');
SELECT is((SELECT should_notify FROM public.record_operator_incident('test-retrieval', 'crawler_retrieval_failures', true, 'warning', 'improving')), false, 'severity decrease does not trigger another reminder');
SELECT is((SELECT transition FROM public.record_operator_incident('test-retrieval', 'crawler_retrieval_failures', false, 'warning', 'recovered')), 'resolved', 'retrieval incident can resolve');
SELECT public.ack_operator_incident_notifications(ARRAY['test-retrieval']);
SELECT is((SELECT should_notify FROM public.record_operator_incident('test-retrieval', 'crawler_retrieval_failures', false, 'warning', 'recovered')), false, 'recovery only notifies once');

SELECT public.record_operator_incident('test-workflow-escalation', 'crawler_workflow_health', true, 'warning', 'test');
SELECT public.ack_operator_incident_notifications(ARRAY['test-workflow-escalation']);
SELECT is((SELECT should_notify FROM public.record_operator_incident('test-workflow-escalation', 'crawler_workflow_health', true, 'critical', 'test')), true, 'workflow critical escalation also bypasses cooldown');
SELECT public.record_operator_incident('test-other-kind', 'civic_queue_delay', true, 'warning', 'test');
SELECT public.ack_operator_incident_notifications(ARRAY['test-other-kind']);
SELECT is((SELECT should_notify FROM public.record_operator_incident('test-other-kind', 'civic_queue_delay', true, 'critical', 'test')), false, 'unrelated incident notification policy is unchanged');

SELECT * FROM finish();
ROLLBACK;
