BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(2);

-- Four terminal rows inside the window: three by-design outcomes that must
-- not count (anti-bot delegation, unresolvable host, not_a_pdf sniff) and one
-- genuine failure that must.
INSERT INTO public.crawler_jobs (
  dedupe_key, request_kind, tenant_key, continuation_key, operation,
  pipeline_stage, url, status, attempts, error_class, error_message,
  completed_at
) VALUES
  ('health-antibot', 'proxy', 'tenant', 'health-antibot', 'scrape', 'scrape',
   'https://example.test/antibot', 'terminal_failed', 1, 'fallback_terminal',
   'anti-bot fallback delegated to scrape caller', now() - interval '5 minutes'),
  ('health-dns', 'proxy', 'tenant', 'health-dns', 'scrape', 'scrape',
   'https://your_council_domain.gov/', 'terminal_failed', 1, 'terminal',
   'download failed: cannot resolve your_council_domain.gov',
   now() - interval '5 minutes'),
  ('health-not-a-pdf', 'proxy', 'tenant', 'health-not-a-pdf', 'parse_pdf',
   'parse', 'https://example.test/agenda.aspx', 'terminal_failed', 1,
   'terminal', 'not_a_pdf', now() - interval '5 minutes'),
  ('health-real', 'proxy', 'tenant', 'health-real', 'scrape', 'scrape',
   'https://example.test/broken', 'terminal_failed', 3, 'retryable',
   'Page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE',
   now() - interval '5 minutes');

SELECT is(
  (SELECT terminal_failed_recent FROM public.crawler_operations_health()),
  1::bigint,
  'delegations, unresolvable hosts, and not_a_pdf sniffs are not counted'
);

-- A not_a_pdf message on a scrape job is not the sniff and still counts.
INSERT INTO public.crawler_jobs (
  dedupe_key, request_kind, tenant_key, continuation_key, operation,
  pipeline_stage, url, status, attempts, error_class, error_message,
  completed_at
) VALUES
  ('health-scrape-not-a-pdf', 'proxy', 'tenant', 'health-scrape-not-a-pdf',
   'scrape', 'scrape', 'https://example.test/odd', 'terminal_failed', 1,
   'terminal', 'not_a_pdf', now() - interval '5 minutes');

SELECT is(
  (SELECT terminal_failed_recent FROM public.crawler_operations_health()),
  2::bigint,
  'the not_a_pdf exclusion is scoped to parse_pdf jobs'
);

SELECT * FROM finish();
ROLLBACK;
