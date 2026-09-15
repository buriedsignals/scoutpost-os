BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(33);

CREATE TEMP TABLE fixture AS
SELECT gen_random_uuid() AS user_id, gen_random_uuid() AS scout_id, gen_random_uuid() AS run_id;
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
SELECT user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  user_id::text || '@example.test', '', now(), now(), now()
FROM fixture;
INSERT INTO public.scouts (id, user_id, name, type, url, is_active, schedule_cron)
SELECT scout_id, user_id, 'Timeout recovery Page', 'web', 'https://example.test/notices', false, '1 8 * * *'
FROM fixture;
INSERT INTO public.scout_runs (id, scout_id, user_id, status, crawler_backend)
SELECT run_id, scout_id, user_id, 'running', 'workflow' FROM fixture;

CREATE TEMP TABLE native_job AS
SELECT (public.enqueue_crawler_job(
  'timeout-recovery:' || run_id, 'scout_run', user_id::text, run_id::text,
  'scrape', 'root', 'https://example.test/notices', '{}'::jsonb, 0, 3,
  run_id, scout_id, user_id
)).* FROM fixture;

CREATE TEMP TABLE primary_attempts (
  attempt int, accepted boolean, status text, fallback_reason text,
  error_class text, error_message text, retry_scheduled boolean,
  lease_released boolean, completed boolean, batch_released boolean
);
-- Use the real batch/lease path on every attempt. Moving available_at forwards
-- only skips wall-clock backoff; completion still decides retry eligibility.
DO $$
DECLARE
  v_batch uuid;
  v_claim record;
  v_accepted boolean;
BEGIN
  FOR i IN 1..3 LOOP
    UPDATE public.crawler_jobs SET available_at = now() - interval '1 second'
    WHERE id = (SELECT id FROM native_job);
    SELECT batch_id INTO STRICT v_batch
    FROM public.create_crawler_batches('scrape', 1, 1);
    SELECT * INTO STRICT v_claim FROM public.claim_crawler_batch(v_batch, 600);
    v_accepted := public.complete_crawler_job(
      v_claim.id, v_claim.lease_token, false, NULL, 'timeout',
      'target navigation timeout attempt ' || i
    );
    INSERT INTO primary_attempts
    SELECT j.attempts, v_accepted, j.status, j.fallback_reason, j.error_class, j.error_message,
      j.available_at > now(), j.lease_token IS NULL AND j.lease_expires_at IS NULL,
      j.completed_at IS NOT NULL, j.batch_id IS NULL
    FROM public.crawler_jobs j WHERE j.id = v_claim.id;
  END LOOP;
END;
$$;

SELECT results_eq(
  $$SELECT attempt, accepted, status, fallback_reason FROM primary_attempts ORDER BY attempt$$,
  $$VALUES (1, true, 'retryable_failed'::text, NULL::text),
           (2, true, 'retryable_failed'::text, NULL::text),
           (3, true, 'fallback_required'::text, 'timeout_exhausted'::text)$$,
  'only the third real navigation completion hands native Page work to fallback'
);
SELECT results_eq(
  $$SELECT attempt, retry_scheduled, lease_released, completed, batch_released
    FROM primary_attempts ORDER BY attempt$$,
  $$VALUES (1, true, true, false, true), (2, true, true, false, true), (3, false, true, true, false)$$,
  'retry completions schedule backoff and release their batch while exhaustion closes the primary lease'
);
SELECT results_eq(
  $$SELECT attempt, error_class, error_message FROM primary_attempts ORDER BY attempt$$,
  $$VALUES (1, 'timeout'::text, 'target navigation timeout attempt 1'::text),
           (2, 'timeout'::text, 'target navigation timeout attempt 2'::text),
           (3, 'timeout'::text, 'target navigation timeout attempt 3'::text)$$,
  'the latest genuine target failure survives each durable transition'
);
SELECT is(
  (SELECT count(*) FROM public.create_crawler_batches('scrape', 1, 1)), 0::bigint,
  'exhaustion cannot dispatch a fourth native navigation attempt'
);
SELECT ok(NOT public.complete_crawler_fallback(
  (SELECT id FROM native_job), true, '{"artifacts":[]}'::jsonb
), 'native fallback cannot commit without owning the paid attempt');

CREATE TEMP TABLE fallback_claim AS
SELECT public.claim_page_crawler_fallback((SELECT id FROM native_job)) AS token;
SELECT ok((SELECT token IS NOT NULL FROM fallback_claim), 'running native Page parent permits the first paid claim');
SELECT is(public.claim_page_crawler_fallback((SELECT id FROM native_job)), NULL::uuid,
  'a competing caller cannot start a second paid attempt');
SELECT ok(NOT public.complete_crawler_fallback(
  (SELECT id FROM native_job), true, '{"artifacts":[]}'::jsonb, NULL, gen_random_uuid()
), 'a stale token cannot publish fallback content');
SELECT ok(public.complete_crawler_fallback(
  (SELECT id FROM native_job), true,
  '{"execution_id":"timeout-recovery","fallback_reason":"timeout_exhausted","artifacts":[{"kind":"markdown","key":"test-only/recovered.md"},{"kind":"raw_html","key":"test-only/recovered.html"}]}'::jsonb,
  NULL, (SELECT token FROM fallback_claim)
), 'the single claim owner can publish recovered evidence');
SELECT ok((SELECT status = 'succeeded' AND attempts = 3 AND lease_token IS NULL AND lease_expires_at IS NULL
  AND fallback_started_at IS NOT NULL AND completed_at IS NOT NULL
  FROM public.crawler_jobs WHERE id = (SELECT id FROM native_job)),
  'fallback completion releases ownership without inventing another primary attempt');
SELECT is((SELECT fallback_reason FROM public.crawler_jobs WHERE id = (SELECT id FROM native_job)),
  'timeout_exhausted', 'successful recovery retains its durable timeout provenance');
SELECT is((SELECT result_manifest FROM public.crawler_jobs WHERE id = (SELECT id FROM native_job)),
  '{"provider":"firecrawl","execution_id":"timeout-recovery","fallback_reason":"timeout_exhausted","artifacts":[{"kind":"markdown","key":"test-only/recovered.md"},{"kind":"raw_html","key":"test-only/recovered.html"}]}'::jsonb,
  'consumers receive the recovered artifact manifest with its real provider and reason');
SELECT ok(NOT public.complete_crawler_fallback(
  (SELECT id FROM native_job), false, NULL, 'late duplicate failure', (SELECT token FROM fallback_claim)
), 'duplicate completion cannot overwrite successful recovery');

CREATE TEMP TABLE replayed_job AS
SELECT (public.enqueue_crawler_job(
  'timeout-recovery:' || run_id, 'scout_run', user_id::text, run_id::text,
  'scrape', 'root', 'https://example.test/notices', '{}'::jsonb, 0, 3,
  run_id, scout_id, user_id
)).* FROM fixture;
SELECT is((SELECT id FROM replayed_job), (SELECT id FROM native_job),
  'replayed logical work resolves to the original durable job');
SELECT is((SELECT status FROM replayed_job), 'succeeded', 'enqueue replay does not reopen successful recovery');
SELECT is(public.claim_page_crawler_fallback((SELECT id FROM replayed_job)), NULL::uuid,
  'replay cannot spend a second provider attempt');
SELECT is((SELECT result_manifest ->> 'execution_id' FROM replayed_job), 'timeout-recovery',
  'replay still serves the committed recovery evidence');

-- Separate outcome of the same eligible native transition: a failed paid call
-- must remain terminal rather than authorize another provider attempt.
INSERT INTO public.crawler_jobs (
  dedupe_key, request_kind, tenant_key, continuation_key, scout_run_id, scout_id, user_id,
  operation, pipeline_stage, url, status, attempts, max_attempts, lease_token, lease_expires_at
)
SELECT 'timeout-failure:' || run_id, 'scout_run', user_id::text, run_id::text, run_id, scout_id, user_id,
  'scrape', 'child:failed', 'https://example.test/child', 'running', 3, 3, gen_random_uuid(), now() + interval '5 minutes'
FROM fixture;
CREATE TEMP TABLE failed_primary AS
SELECT id, public.complete_crawler_job(id, lease_token, false, NULL, 'timeout', 'target navigation exhausted') AS accepted
FROM public.crawler_jobs WHERE dedupe_key = 'timeout-failure:' || (SELECT run_id FROM fixture);
SELECT ok((SELECT accepted FROM failed_primary), 'an exhausted native child also enters eligible recovery');
CREATE TEMP TABLE failed_claim AS
SELECT public.claim_page_crawler_fallback((SELECT id FROM failed_primary)) AS token;
SELECT ok((SELECT token IS NOT NULL FROM failed_claim), 'the failed-provider scenario owns its one paid attempt');
SELECT ok(public.complete_crawler_fallback(
  (SELECT id FROM failed_primary), false, NULL, 'provider unavailable', (SELECT token FROM failed_claim)
), 'the paid failure is accepted only from its claim owner');
SELECT ok((SELECT status = 'terminal_failed' AND fallback_reason = 'timeout_exhausted'
  AND error_class = 'fallback_terminal' AND error_message = 'provider unavailable'
  AND result_manifest IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
  FROM public.crawler_jobs WHERE id = (SELECT id FROM failed_primary)),
  'provider failure retains the timeout trigger and remains an honest terminal failure');
SELECT is(public.claim_page_crawler_fallback((SELECT id FROM failed_primary)), NULL::uuid,
  'a failed provider attempt cannot be claimed again');
SELECT ok(NOT public.complete_crawler_fallback(
  (SELECT id FROM failed_primary), true, '{"artifacts":[]}'::jsonb, NULL, (SELECT token FROM failed_claim)
), 'late success cannot rewrite an already completed provider failure');

CREATE TEMP TABLE ineligible_cases (label text PRIMARY KEY, operation text, request_kind text, error_class text);
INSERT INTO ineligible_cases VALUES
  ('snapshot', 'snapshot', 'scout_run', 'timeout'),
  ('pdf', 'parse_pdf', 'scout_run', 'timeout'),
  ('benchmark', 'scrape', 'benchmark', 'timeout'),
  ('target-terminal', 'scrape', 'scout_run', 'terminal'),
  ('transport-retryable', 'scrape', 'scout_run', 'retryable');
INSERT INTO public.crawler_jobs (
  dedupe_key, request_kind, tenant_key, continuation_key, scout_run_id, scout_id, user_id,
  operation, pipeline_stage, url, status, attempts, max_attempts, lease_token, lease_expires_at
)
SELECT 'ineligible:' || c.label || ':' || f.run_id, c.request_kind, f.user_id::text, f.run_id::text,
  f.run_id, f.scout_id, f.user_id, c.operation, c.label, 'https://example.test/ineligible',
  'running', 3, 3, gen_random_uuid(), now() + interval '5 minutes'
FROM ineligible_cases c CROSS JOIN fixture f;
CREATE TEMP TABLE excluded_completions AS
SELECT c.label, j.id,
  public.complete_crawler_job(j.id, j.lease_token, false, NULL, c.error_class, c.label || ' failure') AS accepted
FROM ineligible_cases c JOIN public.crawler_jobs j
  ON j.dedupe_key = 'ineligible:' || c.label || ':' || (SELECT run_id FROM fixture);
SELECT results_eq(
  $$SELECT label, accepted FROM excluded_completions ORDER BY label$$,
  $$VALUES ('benchmark'::text, true), ('pdf'::text, true), ('snapshot'::text, true),
           ('target-terminal'::text, true), ('transport-retryable'::text, true)$$,
  'excluded operations and failure classes are completed through the real native completion RPC'
);
SELECT results_eq(
  $$SELECT e.label, j.status, j.fallback_reason
    FROM excluded_completions e JOIN public.crawler_jobs j ON j.id = e.id ORDER BY e.label$$,
  $$VALUES ('benchmark'::text, 'terminal_failed'::text, NULL::text),
           ('pdf'::text, 'terminal_failed'::text, NULL::text),
           ('snapshot'::text, 'terminal_failed'::text, NULL::text),
           ('target-terminal'::text, 'terminal_failed'::text, NULL::text),
           ('transport-retryable'::text, 'terminal_failed'::text, NULL::text)$$,
  'non-scrape, benchmark, terminal target, and generic transport failures never become timeout fallback'
);
SELECT ok(NOT EXISTS (
  SELECT 1 FROM excluded_completions WHERE public.claim_page_crawler_fallback(id) IS NOT NULL
), 'no excluded result authorizes a native paid claim');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM excluded_completions e JOIN public.crawler_jobs j ON j.id = e.id
  WHERE j.lease_token IS NOT NULL OR j.lease_expires_at IS NOT NULL OR j.completed_at IS NULL
), 'terminal exclusions release their native leases and are not left waiting for recovery');
SELECT is((SELECT is_active FROM public.scouts WHERE id = (SELECT scout_id FROM fixture)), false,
  'recovery does not unpause the Page Scout');
SELECT is((SELECT status FROM public.scout_runs WHERE id = (SELECT run_id FROM fixture)), 'running',
  'retrieval recovery does not fabricate a successful parent analysis');
SELECT is((SELECT count(*) FROM public.crawler_jobs WHERE scout_run_id = (SELECT run_id FROM fixture)
  AND fallback_started_at IS NOT NULL), 2::bigint,
  'only the two eligible outcomes ever acquire a provider attempt');

INSERT INTO public.crawler_jobs (
  dedupe_key, request_kind, tenant_key, continuation_key, scout_run_id, scout_id, user_id,
  operation, pipeline_stage, url, status, attempts, max_attempts, lease_token, lease_expires_at
)
SELECT 'expired-worker:' || run_id, 'scout_run', user_id::text, run_id::text, run_id, scout_id, user_id,
  'scrape', 'expired-worker', 'https://example.test/expired-worker', 'running',
  3, 3, gen_random_uuid(), now() - interval '1 second' FROM fixture;
DO $$ BEGIN PERFORM public.reconcile_crawler_jobs(); END $$;
SELECT is((SELECT status FROM public.crawler_jobs WHERE pipeline_stage = 'expired-worker'
  AND scout_run_id = (SELECT run_id FROM fixture)), 'terminal_failed',
  'exhausted worker lease expiry is an infrastructure failure, not navigation recovery');
SELECT is((SELECT fallback_reason FROM public.crawler_jobs WHERE pipeline_stage = 'expired-worker'
  AND scout_run_id = (SELECT run_id FROM fixture)), NULL::text,
  'worker lease expiry does not invent navigation-timeout provenance');
SELECT ok((SELECT public.claim_page_crawler_fallback(id) IS NULL FROM public.crawler_jobs
  WHERE pipeline_stage = 'expired-worker' AND scout_run_id = (SELECT run_id FROM fixture)),
  'expired worker cannot authorize paid Firecrawl recovery');

SELECT * FROM finish();
ROLLBACK;
