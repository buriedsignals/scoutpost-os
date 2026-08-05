BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(28);

SELECT has_index(
  'public',
  'crawler_batches',
  'crawler_batches_pending_submission_recovery_idx',
  'ambiguous-start recovery has a bounded pending-batch index'
);

INSERT INTO public.crawler_jobs (
  dedupe_key, request_kind, tenant_key, continuation_key,
  operation, pipeline_stage, url
)
SELECT
  'dispatch:' || n, 'benchmark', 'tenant:' || n, 'bench:' || n,
  'snapshot', 'fetch', 'https://example.test/' || n
FROM generate_series(1, 32) n;

CREATE TEMP TABLE dispatch_batches AS
SELECT row_number() OVER () AS n, result.*
FROM public.create_crawler_batches('snapshot', 1, 32) result;

SELECT is(
  (SELECT count(*) FROM dispatch_batches),
  32::bigint,
  'dispatcher forms the requested batches'
);

CREATE TEMP TABLE reservations AS
SELECT b.n, b.batch_id, public.reserve_crawler_batch_submission(b.batch_id, 28) token
FROM dispatch_batches b
ORDER BY b.n;

SELECT is(
  (SELECT count(*) FROM reservations WHERE token IS NOT NULL),
  28::bigint,
  'sliding start budget admits exactly twenty-eight reservations'
);
SELECT is(
  (SELECT count(*) FROM reservations WHERE token IS NULL),
  4::bigint,
  'sliding start budget leaves overflow unreserved'
);
SELECT is(
  public.reserve_crawler_batch_submission(
    (SELECT batch_id FROM reservations WHERE token IS NOT NULL LIMIT 1), 28
  ),
  NULL::uuid,
  'one batch cannot reserve a second POST attempt'
);

SELECT ok(
  NOT public.release_crawler_batch(
    (SELECT batch_id FROM reservations WHERE token IS NOT NULL LIMIT 1),
    gen_random_uuid(),
    'wrong owner'
  ),
  'wrong reservation token cannot release work'
);

CREATE TEMP TABLE submitted AS
SELECT * FROM reservations WHERE token IS NOT NULL LIMIT 1;
SELECT ok(
  public.mark_crawler_batch_submitted(
    (SELECT batch_id FROM submitted),
    (SELECT token FROM submitted),
    'trn-submitted'
  ),
  'reservation owner acknowledges one Render task run'
);
SELECT ok(
  NOT public.mark_crawler_batch_submitted(
    (SELECT batch_id FROM submitted),
    (SELECT token FROM submitted),
    'trn-duplicate'
  ),
  'submission acknowledgement is one-shot'
);

CREATE TEMP TABLE claimed_before_callback AS
SELECT * FROM reservations
WHERE token IS NOT NULL AND batch_id <> (SELECT batch_id FROM submitted)
LIMIT 1;
CREATE TEMP TABLE early_claim AS
SELECT * FROM public.claim_crawler_batch(
  (SELECT batch_id FROM claimed_before_callback), 600
);
SELECT ok(
  public.mark_crawler_batch_submitted(
    (SELECT batch_id FROM claimed_before_callback),
    (SELECT token FROM claimed_before_callback),
    'trn-claimed-first'
  ),
  'claim may safely arrive before API acknowledgement'
);
SELECT is(
  (SELECT status FROM public.crawler_batches
    WHERE id = (SELECT batch_id FROM claimed_before_callback)),
  'running',
  'late API acknowledgement preserves running state'
);

CREATE TEMP TABLE overflow AS
SELECT * FROM reservations WHERE token IS NULL LIMIT 1;
SELECT ok(
  public.release_crawler_batch(
    (SELECT batch_id FROM overflow), NULL, 'budget exhausted'
  ),
  'unreserved overflow batch can be released immediately'
);
SELECT is(
  (SELECT status FROM public.crawler_jobs
    WHERE id = (SELECT (job_ids)[1] FROM dispatch_batches
      WHERE batch_id = (SELECT batch_id FROM overflow))),
  'queued',
  'released batch returns its job to the queue'
);

SELECT ok(
  public.reconcile_crawler_render_run(
    (SELECT batch_id FROM submitted), 'trn-submitted', 'failed',
    '{"status":"failed"}'::jsonb
  ),
  'Render terminal state reconciles the acknowledged batch'
);
SELECT is(
  (SELECT status FROM public.crawler_batches WHERE id = (SELECT batch_id FROM submitted)),
  'failed',
  'Render failure before claim fails the batch without losing its jobs'
);

CREATE TEMP TABLE completed_without_claim AS
SELECT * FROM reservations
WHERE token IS NOT NULL
  AND batch_id <> (SELECT batch_id FROM submitted)
  AND batch_id <> (SELECT batch_id FROM claimed_before_callback)
LIMIT 1;
SELECT ok(
  public.mark_crawler_batch_submitted(
    (SELECT batch_id FROM completed_without_claim),
    (SELECT token FROM completed_without_claim),
    'trn-completed-without-claim'
  ),
  'another reserved batch is acknowledged'
);
SELECT ok(
  public.reconcile_crawler_render_run(
    (SELECT batch_id FROM completed_without_claim),
    'trn-completed-without-claim', 'succeeded', '{"status":"succeeded"}'::jsonb
  ),
  'a terminal task that never claimed is reconciled'
);
SELECT is(
  (SELECT status FROM public.crawler_jobs
    WHERE id = (SELECT (job_ids)[1] FROM dispatch_batches
      WHERE batch_id = (SELECT batch_id FROM completed_without_claim))),
  'queued',
  'terminal task without a claim releases its job'
);

CREATE TEMP TABLE stale_unreserved AS
SELECT * FROM reservations WHERE token IS NULL AND batch_id <> (SELECT batch_id FROM overflow)
LIMIT 1;
UPDATE public.crawler_batches
SET created_at = now() - interval '3 minutes'
WHERE id = (SELECT batch_id FROM stale_unreserved);
DO $$ BEGIN PERFORM public.reconcile_crawler_jobs(); END $$;
SELECT is(
  (SELECT status FROM public.crawler_batches
    WHERE id = (SELECT batch_id FROM stale_unreserved)),
  'failed',
  'an unreserved dispatcher crash is released after two minutes'
);
SELECT is(
  (SELECT status FROM public.crawler_jobs
    WHERE id = (SELECT (job_ids)[1] FROM dispatch_batches
      WHERE batch_id = (SELECT batch_id FROM stale_unreserved))),
  'queued',
  'stale unreserved work returns to the queue'
);

CREATE TEMP TABLE ambiguous_submission AS
SELECT * FROM reservations
WHERE token IS NOT NULL
  AND batch_id <> (SELECT batch_id FROM submitted)
  AND batch_id <> (SELECT batch_id FROM claimed_before_callback)
  AND batch_id <> (SELECT batch_id FROM completed_without_claim)
LIMIT 1;
SELECT is(
  (SELECT batches_released FROM public.release_stale_crawler_submissions()),
  0,
  'a fresh ambiguous start remains reserved during its grace period'
);
UPDATE public.crawler_batches
SET submission_reserved_at = now() - interval '119 seconds'
WHERE id = (SELECT batch_id FROM ambiguous_submission);
SELECT is(
  (SELECT batches_released FROM public.release_stale_crawler_submissions()),
  0,
  'an ambiguous start remains reserved through 119 seconds'
);
UPDATE public.crawler_batches
SET submission_reserved_at = now() - interval '121 seconds'
WHERE id = (SELECT batch_id FROM ambiguous_submission);
SELECT is(
  (SELECT batches_released FROM public.release_stale_crawler_submissions()),
  1,
  'an unclaimed ambiguous start releases after two minutes'
);
SELECT is(
  (SELECT status FROM public.crawler_jobs
    WHERE id = (SELECT (job_ids)[1] FROM dispatch_batches
      WHERE batch_id = (SELECT batch_id FROM ambiguous_submission))),
  'queued',
  'prompt ambiguous-start recovery returns its job to the queue'
);
SELECT is(
  (SELECT count(*) FROM public.claim_crawler_batch(
    (SELECT batch_id FROM ambiguous_submission), 600
  )),
  0::bigint,
  'a late original task cannot claim work after recovery'
);

CREATE TEMP TABLE claimed_ambiguous AS
SELECT * FROM reservations
WHERE token IS NOT NULL
  AND batch_id <> (SELECT batch_id FROM submitted)
  AND batch_id <> (SELECT batch_id FROM claimed_before_callback)
  AND batch_id <> (SELECT batch_id FROM completed_without_claim)
  AND batch_id <> (SELECT batch_id FROM ambiguous_submission)
LIMIT 1;
UPDATE public.crawler_batches
SET submission_reserved_at = now() - interval '3 minutes'
WHERE id = (SELECT batch_id FROM claimed_ambiguous);
SELECT * FROM public.claim_crawler_batch(
  (SELECT batch_id FROM claimed_ambiguous), 600
);
SELECT is(
  (SELECT batches_released FROM public.release_stale_crawler_submissions()),
  0,
  'a task that claimed before acknowledgement is never released'
);
SELECT is(
  (SELECT status FROM public.crawler_batches
    WHERE id = (SELECT batch_id FROM claimed_ambiguous)),
  'running',
  'claimed ambiguous work remains owned by its running task'
);

CREATE TEMP TABLE rejected_submission AS
SELECT * FROM reservations
WHERE token IS NOT NULL
  AND batch_id NOT IN (
    SELECT batch_id FROM submitted
    UNION ALL SELECT batch_id FROM claimed_before_callback
    UNION ALL SELECT batch_id FROM completed_without_claim
    UNION ALL SELECT batch_id FROM ambiguous_submission
    UNION ALL SELECT batch_id FROM claimed_ambiguous
  )
LIMIT 1;
SELECT ok(
  public.release_crawler_batch(
    (SELECT batch_id FROM rejected_submission),
    (SELECT token FROM rejected_submission),
    'render rejected task start (429)'
  ),
  'the reservation owner can release a definitively rejected start'
);
SELECT is(
  (SELECT status FROM public.crawler_jobs
    WHERE id = (SELECT (job_ids)[1] FROM dispatch_batches
      WHERE batch_id = (SELECT batch_id FROM rejected_submission))),
  'queued',
  'a definitively rejected start returns its job to the queue immediately'
);

SELECT * FROM finish();
ROLLBACK;
