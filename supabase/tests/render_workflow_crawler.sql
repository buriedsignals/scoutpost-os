BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(21);

SELECT has_table('public', 'crawler_jobs', 'crawler job ledger exists');
SELECT has_table('public', 'crawler_batches', 'crawler batch ledger exists');

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.crawler_jobs', 'SELECT'),
  'authenticated users cannot read crawler jobs'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.enqueue_crawler_job(text,text,text,text,text,text,text,jsonb,integer,integer,uuid,uuid,uuid)',
    'EXECUTE'
  ),
  'authenticated users cannot enqueue crawler jobs'
);

CREATE TEMP TABLE generic_job AS
SELECT (public.enqueue_crawler_job(
  'generic:one', 'ingest', 'system:ingest', 'ingest:one',
  'snapshot', 'fetch', 'https://example.test/one', '{}'::jsonb
)).*;

SELECT is(
  (SELECT request_kind FROM generic_job),
  'ingest',
  'generic consumers enqueue without fake Scout context'
);
SELECT is(
  (SELECT count(*) FROM public.crawler_jobs WHERE dedupe_key = 'generic:one'),
  1::bigint,
  'first enqueue creates one durable job'
);

SELECT public.enqueue_crawler_job(
  'generic:one', 'ingest', 'changed-tenant', 'changed-continuation',
  'snapshot', 'changed-stage', 'https://example.test/changed', '{}'::jsonb
);

SELECT is(
  (SELECT count(*) FROM public.crawler_jobs WHERE dedupe_key = 'generic:one'),
  1::bigint,
  'duplicate enqueue does not create a second row'
);
SELECT is(
  (SELECT url FROM public.crawler_jobs WHERE dedupe_key = 'generic:one'),
  'https://example.test/one',
  'duplicate enqueue does not mutate the original row'
);

-- One heavy tenant and 100 small tenants exercise fairness across the whole
-- cycle, including batch boundaries.
INSERT INTO public.crawler_jobs (
  dedupe_key, request_kind, tenant_key, continuation_key,
  operation, pipeline_stage, url
)
SELECT
  'heavy:' || n, 'benchmark', 'tenant:heavy', 'bench:heavy',
  'scrape', 'fetch', 'https://example.test/heavy/' || n
FROM generate_series(1, 193) n;

INSERT INTO public.crawler_jobs (
  dedupe_key, request_kind, tenant_key, continuation_key,
  operation, pipeline_stage, url
)
SELECT
  'small:' || n, 'benchmark', 'tenant:small:' || n, 'bench:small:' || n,
  'scrape', 'fetch', 'https://example.test/small/' || n
FROM generate_series(1, 100) n;

CREATE TEMP TABLE fairness_batches (
  batch_order bigint GENERATED ALWAYS AS IDENTITY,
  batch_id uuid,
  job_ids uuid[]
);
INSERT INTO fairness_batches (batch_id, job_ids)
SELECT * FROM public.create_crawler_batches('scrape', 20, 293);

CREATE TEMP TABLE fairness_order AS
SELECT row_number() OVER (ORDER BY b.batch_order, u.item_order) AS dispatch_order,
       j.tenant_key, j.id
FROM fairness_batches b
CROSS JOIN LATERAL unnest(b.job_ids) WITH ORDINALITY AS u(job_id, item_order)
JOIN public.crawler_jobs j ON j.id = u.job_id
ORDER BY b.batch_order, u.item_order;

SELECT is(
  (SELECT count(*) FROM fairness_order WHERE dispatch_order <= 101 AND tenant_key LIKE 'tenant:small:%'),
  100::bigint,
  'all one-job tenants are served before the heavy tenant receives rank two'
);
SELECT is(
  (SELECT count(DISTINCT id) FROM fairness_order),
  293::bigint,
  'one dispatch cycle assigns every selected job exactly once'
);
SELECT is(
  (SELECT max(cardinality(job_ids)) FROM fairness_batches),
  20,
  'batch size is capped at twenty'
);

-- Claim one batch twice. The second process sees identical live attempts.
CREATE TEMP TABLE first_claim AS
SELECT * FROM public.claim_crawler_batch(
  (SELECT batch_id FROM fairness_batches LIMIT 1), 600
);
CREATE TEMP TABLE repeated_claim AS
SELECT * FROM public.claim_crawler_batch(
  (SELECT batch_id FROM fairness_batches LIMIT 1), 600
);

SELECT is(
  (SELECT count(*) FROM first_claim),
  (SELECT count(*) FROM repeated_claim),
  'repeated claim returns the unfinished jobs'
);
SELECT is(
  (SELECT count(*) FROM first_claim a JOIN repeated_claim b USING (id) WHERE a.lease_token = b.lease_token),
  (SELECT count(*) FROM first_claim),
  'repeated claim preserves lease tokens'
);
SELECT is(
  (SELECT max(attempts) FROM public.crawler_jobs WHERE id IN (SELECT id FROM first_claim)),
  1,
  'repeated claim does not increment attempts'
);

CREATE TEMP TABLE completion_target AS
SELECT * FROM first_claim LIMIT 1;

SELECT ok(
  public.complete_crawler_job(
    (SELECT id FROM completion_target),
    (SELECT lease_token FROM completion_target),
    true,
    '{"artifacts":[]}'::jsonb
  ),
  'live lease completion succeeds'
);
SELECT ok(
  NOT public.complete_crawler_job(
    (SELECT id FROM completion_target),
    (SELECT lease_token FROM completion_target),
    true,
    '{"artifacts":[]}'::jsonb
  ),
  'duplicate completion is rejected'
);
SELECT ok(
  NOT public.complete_crawler_job(
    (SELECT id FROM first_claim OFFSET 1 LIMIT 1),
    gen_random_uuid(),
    true,
    '{"artifacts":[]}'::jsonb
  ),
  'stale lease completion is rejected'
);

-- Expiry requeues a retryable job and terminalizes an exhausted one.
UPDATE public.crawler_jobs
SET lease_expires_at = now() - interval '1 second'
WHERE id = (SELECT id FROM first_claim OFFSET 1 LIMIT 1);

UPDATE public.crawler_jobs
SET lease_expires_at = now() - interval '1 second',
    attempts = max_attempts
WHERE id = (SELECT id FROM first_claim OFFSET 2 LIMIT 1);

DO $$ BEGIN PERFORM public.reconcile_crawler_jobs(); END $$;

SELECT is(
  (SELECT status FROM public.crawler_jobs WHERE id = (SELECT id FROM first_claim OFFSET 1 LIMIT 1)),
  'retryable_failed',
  'expired live lease is requeued durably'
);
SELECT is(
  (SELECT status FROM public.crawler_jobs WHERE id = (SELECT id FROM first_claim OFFSET 2 LIMIT 1)),
  'terminal_failed',
  'expired exhausted lease becomes terminal'
);

SELECT ok(
  NOT public.complete_crawler_job(
    (SELECT id FROM first_claim OFFSET 2 LIMIT 1),
    (SELECT lease_token FROM first_claim OFFSET 2 LIMIT 1),
    true,
    '{"artifacts":[]}'::jsonb
  ),
  'terminal jobs cannot reopen'
);

SELECT throws_ok(
  $$SELECT public.admit_and_enqueue_crawler_utility(
    'bad-kind', 'benchmark', 'tenant:test', 'test', 'scrape', 'fetch',
    'https://example.test', '{}'::jsonb, 100
  )$$,
  'P0001',
  'invalid utility request kind',
  'utility admission accepts only fixed utility request kinds'
);

SELECT * FROM finish();
ROLLBACK;
