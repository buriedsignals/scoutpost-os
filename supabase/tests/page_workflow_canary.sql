BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(25);

SELECT has_index('public', 'raw_captures', 'raw_captures_workflow_effect_idx',
  'raw capture effects have a durable idempotency key');
SELECT has_index('public', 'usage_records', 'usage_records_idempotency_idx',
  'credit effects have a durable idempotency key');
SELECT has_function('public', 'decrement_credits_once',
  ARRAY['text', 'uuid', 'integer', 'uuid', 'text', 'text'],
  'idempotent credit decrement exists');
SELECT has_function('public', 'refund_credits_once',
  ARRAY['text', 'uuid', 'integer', 'uuid', 'text', 'text'],
  'idempotent credit refund exists');

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000001141',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'page-workflow@example.test', '',
  now(), now(), now()
);
INSERT INTO public.scouts (
  id, user_id, name, type, url, provider, is_active, schedule_cron,
  baseline_established_at
) VALUES (
  '00000000-0000-4000-8000-000000001142',
  '00000000-0000-4000-8000-000000001141',
  'Page workflow', 'web', 'https://example.com', 'firecrawl_plain', true,
  '1 8 * * *', now()
);

CREATE TEMP TABLE enqueued AS
SELECT * FROM public.enqueue_scout_dispatch(
  '00000000-0000-4000-8000-000000001142', NULL, 'manual', 100, 'workflow'
);
SELECT is((SELECT crawler_backend FROM enqueued), 'workflow',
  'Page run is pinned to Workflow before queue admission');

CREATE TEMP TABLE claimed_dispatch AS
SELECT * FROM public.claim_scout_dispatch_batch('page-worker', 3, 3, 900, 3);
SELECT ok(
  public.park_scout_dispatch((SELECT queue_id FROM claimed_dispatch), 'page-worker'),
  'HTTP 202 parks the launch row without consuming launch capacity'
);
SELECT is(
  (SELECT status FROM public.scout_dispatch_queue
    WHERE id = (SELECT queue_id FROM claimed_dispatch)),
  'waiting',
  'parked launch row is waiting'
);

CREATE TEMP TABLE coalesced AS
SELECT * FROM public.enqueue_scout_dispatch(
  '00000000-0000-4000-8000-000000001142', NULL, 'scheduled', 0, 'service'
);
SELECT is((SELECT run_id FROM coalesced), (SELECT run_id FROM enqueued),
  'waiting run coalesces a duplicate launch');
SELECT is((SELECT crawler_backend FROM coalesced), 'workflow',
  'coalescing cannot repin an in-flight run');

CREATE TEMP TABLE stage_claim AS
SELECT * FROM public.claim_page_workflow_run((SELECT run_id FROM enqueued), 300);
SELECT is((SELECT workflow_stage FROM stage_claim), 'needs_root',
  'first stage claim initializes the root stage');
SELECT is(
  (SELECT count(*) FROM public.claim_page_workflow_run((SELECT run_id FROM enqueued), 300)),
  0::bigint,
  'a live stage lease excludes a competing resume'
);
SELECT ok(
  public.set_page_workflow_stage(
    (SELECT run_id FROM enqueued), (SELECT lease_token FROM stage_claim),
    'waiting_root', true
  ),
  'stage transition releases the durable lease'
);
SELECT is(
  (SELECT count(*) FROM public.pending_page_workflow_resumes(100)
    WHERE run_id = (SELECT run_id FROM enqueued)),
  1::bigint,
  'minute reconciliation can redeliver a lost continuation'
);

INSERT INTO public.credit_accounts (
  user_id, tier, monthly_cap, balance, entitlement_source
) VALUES (
  '00000000-0000-4000-8000-000000001141',
  'pro', 100, 100, 'cojournalist-pro'
);
CREATE TEMP TABLE first_charge AS
SELECT * FROM public.decrement_credits_once(
  'page:test-run:charge',
  '00000000-0000-4000-8000-000000001141', 10,
  '00000000-0000-4000-8000-000000001142', 'web', 'website_extraction'
);
CREATE TEMP TABLE second_charge AS
SELECT * FROM public.decrement_credits_once(
  'page:test-run:charge',
  '00000000-0000-4000-8000-000000001141', 10,
  '00000000-0000-4000-8000-000000001142', 'web', 'website_extraction'
);
SELECT is((SELECT balance FROM first_charge), 90,
  'first keyed charge returns the debited balance');
SELECT is((SELECT balance FROM second_charge), 90,
  'duplicate keyed charge returns the original balance');
SELECT is(
  (SELECT count(*) FROM public.usage_records
    WHERE idempotency_key = 'page:test-run:charge'),
  1::bigint, 'duplicate keyed charge writes one usage record'
);

CREATE TEMP TABLE first_refund AS
SELECT * FROM public.refund_credits_once(
  'page:test-run:refund',
  '00000000-0000-4000-8000-000000001141', 10,
  '00000000-0000-4000-8000-000000001142', 'web', 'website_extraction'
);
CREATE TEMP TABLE second_refund AS
SELECT * FROM public.refund_credits_once(
  'page:test-run:refund',
  '00000000-0000-4000-8000-000000001141', 10,
  '00000000-0000-4000-8000-000000001142', 'web', 'website_extraction'
);
SELECT is((SELECT new_balance FROM first_refund), 100,
  'first keyed refund restores the balance');
SELECT is((SELECT new_balance FROM second_refund), 100,
  'duplicate keyed refund returns the original balance');
SELECT is(
  (SELECT count(*) FROM public.usage_records
    WHERE idempotency_key = 'page:test-run:refund'),
  1::bigint, 'duplicate keyed refund writes one usage record'
);

UPDATE public.scout_runs SET status = 'success', completed_at = now()
WHERE id = (SELECT run_id FROM enqueued);
SELECT ok(public.finish_waiting_scout_dispatch((SELECT run_id FROM enqueued)),
  'terminal Page run closes its waiting launch row');
SELECT is(
  (SELECT status FROM public.scout_dispatch_queue
    WHERE scout_run_id = (SELECT run_id FROM enqueued)),
  'done',
  'successful Page workflow frees the coalescing slot'
);

CREATE TEMP TABLE stale_enqueued AS
SELECT * FROM public.enqueue_scout_dispatch(
  '00000000-0000-4000-8000-000000001142', NULL, 'scheduled', 0, 'workflow'
);
CREATE TEMP TABLE stale_dispatch AS
SELECT * FROM public.claim_scout_dispatch_batch('stale-worker', 3, 3, 900, 3);
SELECT public.park_scout_dispatch(
  (SELECT queue_id FROM stale_dispatch), 'stale-worker'
);
CREATE TEMP TABLE stale_stage AS
SELECT * FROM public.claim_page_workflow_run(
  (SELECT run_id FROM stale_enqueued), 300
);
SELECT public.set_page_workflow_stage(
  (SELECT run_id FROM stale_enqueued), (SELECT lease_token FROM stale_stage),
  'waiting_root', true
);
SELECT * FROM public.decrement_credits_once(
  'page:' || (SELECT run_id FROM stale_enqueued)::text || ':charge',
  '00000000-0000-4000-8000-000000001141', 10,
  '00000000-0000-4000-8000-000000001142', 'web', 'website_extraction'
);
UPDATE public.scout_runs SET workflow_progressed_at = now() - interval '31 minutes'
WHERE id = (SELECT run_id FROM stale_enqueued);
SELECT is(public.reconcile_waiting_scout_dispatches(), 1,
  'stalled terminal-work continuation is reconciled once');
SELECT is(
  (SELECT status FROM public.scout_runs
    WHERE id = (SELECT run_id FROM stale_enqueued)),
  'error', 'stalled Page workflow becomes terminal'
);
SELECT is(
  (SELECT status FROM public.scout_dispatch_queue
    WHERE scout_run_id = (SELECT run_id FROM stale_enqueued)),
  'failed', 'stalled Page workflow releases its queue slot'
);
SELECT is(
  (SELECT balance FROM public.credit_accounts
    WHERE user_id = '00000000-0000-4000-8000-000000001141'),
  100, 'stalled Page workflow refunds its keyed charge'
);

SELECT * FROM finish();
ROLLBACK;
