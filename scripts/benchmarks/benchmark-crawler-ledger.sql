\set ON_ERROR_STOP on
\timing on

-- Gate B database scale probe. The transaction always rolls back, so the
-- 200,000 synthetic rows never become durable production data.
BEGIN;
SET LOCAL statement_timeout = '5min';

INSERT INTO public.crawler_jobs (
  dedupe_key, request_kind, tenant_key, continuation_key,
  operation, pipeline_stage, url, status, completed_at
)
SELECT
  'gate-b-ledger:' || n,
  'benchmark',
  'gate-b-tenant:' || (n % 10000),
  'gate-b-ledger',
  'scrape',
  'ledger_scale',
  'https://gate-b.invalid/' || n,
  CASE WHEN n <= 190000 THEN 'succeeded' ELSE 'queued' END,
  CASE WHEN n <= 190000 THEN now() - interval '8 days' ELSE NULL END
FROM generate_series(1, 200000) AS n;

ANALYZE public.crawler_jobs;

-- This is the eligible portion of create_crawler_batches. The plan must use
-- crawler_jobs_dispatch_idx; a full crawler_jobs sequential scan fails review.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, tenant_key, available_at, created_at,
  GREATEST(
    LEAST(priority, 100),
    LEAST(100, FLOOR(EXTRACT(EPOCH FROM (now() - available_at)) / 60) * 20)
  )::int AS effective_priority
FROM public.crawler_jobs
WHERE operation = 'scrape'
  AND status IN ('queued', 'retryable_failed')
  AND available_at <= now();

CREATE TEMP TABLE gate_b_batches (batch_id uuid PRIMARY KEY);
INSERT INTO gate_b_batches
SELECT batch_id FROM public.create_crawler_batches('scrape', 20, 600);
INSERT INTO gate_b_batches
SELECT batch_id FROM public.create_crawler_batches('scrape', 20, 600);
INSERT INTO gate_b_batches
SELECT batch_id FROM public.create_crawler_batches('scrape', 20, 600);
INSERT INTO gate_b_batches
SELECT batch_id FROM public.create_crawler_batches('scrape', 20, 600);

CREATE TEMP TABLE gate_b_claim_ms (elapsed_ms double precision NOT NULL);
DO $$
DECLARE
  v_batch_id uuid;
  v_started timestamptz;
BEGIN
  FOR v_batch_id IN SELECT batch_id FROM gate_b_batches LIMIT 100 LOOP
    v_started := clock_timestamp();
    PERFORM 1 FROM public.claim_crawler_batch(v_batch_id, 600);
    INSERT INTO gate_b_claim_ms VALUES (
      EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000
    );
  END LOOP;
END;
$$;

SELECT round(percentile_cont(0.95) WITHIN GROUP (ORDER BY elapsed_ms)::numeric, 3)
  AS claim_p95_ms,
       round(max(elapsed_ms)::numeric, 3) AS claim_max_ms,
       count(*) AS samples
FROM gate_b_claim_ms;

DO $$
DECLARE
  v_p95 double precision;
BEGIN
  SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY elapsed_ms)
    INTO v_p95 FROM gate_b_claim_ms;
  IF v_p95 >= 100 THEN
    RAISE EXCEPTION 'Gate B claim p95 % ms is not below 100 ms', v_p95;
  END IF;
END;
$$;

ROLLBACK;
