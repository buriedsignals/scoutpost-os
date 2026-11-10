BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(14);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000001501',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'social-queue@example.test', '',
  now(), now(), now()
);
INSERT INTO public.credit_accounts (
  user_id, tier, monthly_cap, balance, entitlement_source
) VALUES (
  '00000000-0000-4000-8000-000000001501', 'pro', 100, 100, 'cojournalist-pro'
);
INSERT INTO public.scouts (
  id, user_id, name, type, platform, profile_handle, is_active, schedule_cron
) VALUES
  ('00000000-0000-4000-8000-000000001511', '00000000-0000-4000-8000-000000001501', 'Social dead', 'social', 'x', 'dead', true, '1 8 * * *'),
  ('00000000-0000-4000-8000-000000001512', '00000000-0000-4000-8000-000000001501', 'Social alive', 'social', 'x', 'alive', true, '2 8 * * *'),
  ('00000000-0000-4000-8000-000000001513', '00000000-0000-4000-8000-000000001501', 'Social refunded', 'social', 'x', 'refunded', true, '3 8 * * *'),
  ('00000000-0000-4000-8000-000000001514', '00000000-0000-4000-8000-000000001501', 'Social uncharged', 'social', 'x', 'uncharged', true, '4 8 * * *');

-- The queue accepts social runs and parks them like Beat.
CREATE TEMP TABLE dead AS
SELECT * FROM public.enqueue_scout_dispatch('00000000-0000-4000-8000-000000001511', NULL, 'scheduled', 0);
CREATE TEMP TABLE alive AS
SELECT * FROM public.enqueue_scout_dispatch('00000000-0000-4000-8000-000000001512', NULL, 'scheduled', 0);
CREATE TEMP TABLE refunded AS
SELECT * FROM public.enqueue_scout_dispatch('00000000-0000-4000-8000-000000001513', NULL, 'scheduled', 0);
CREATE TEMP TABLE uncharged AS
SELECT * FROM public.enqueue_scout_dispatch('00000000-0000-4000-8000-000000001514', NULL, 'scheduled', 0);
SELECT is(
  (SELECT count(*) FROM public.scout_dispatch_queue
    WHERE scout_type = 'social'
      AND scout_run_id IN (SELECT run_id FROM dead UNION SELECT run_id FROM alive
                           UNION SELECT run_id FROM refunded UNION SELECT run_id FROM uncharged)),
  4::bigint, 'enqueue_scout_dispatch queues social scouts'
);
SELECT is(
  (SELECT stage FROM public.scout_runs WHERE id = (SELECT run_id FROM dead)),
  'queued', 'a queued social run starts at stage queued (the worker claim key)'
);

CREATE TEMP TABLE claimed AS
SELECT * FROM public.claim_scout_dispatch_batch('social-worker', 4, 4, 900, 3);
SELECT public.park_scout_dispatch(queue_id, 'social-worker') FROM claimed;
SELECT is(
  (SELECT count(*) FROM public.scout_dispatch_queue WHERE status = 'waiting'
    AND scout_run_id IN (SELECT run_id FROM claimed)),
  4::bigint, 'HTTP 202 parks every social run as waiting'
);

-- Each worker charged with the key the worker uses.
SELECT public.decrement_credits_once('social:' || run_id::text || ':charge',
  '00000000-0000-4000-8000-000000001501', 2,
  '00000000-0000-4000-8000-000000001511', 'social', 'social_monitoring_x')
  FROM dead;
SELECT public.decrement_credits_once('social:' || run_id::text || ':charge',
  '00000000-0000-4000-8000-000000001501', 2,
  '00000000-0000-4000-8000-000000001512', 'social', 'social_monitoring_x')
  FROM alive;
SELECT public.decrement_credits_once('social:' || run_id::text || ':charge',
  '00000000-0000-4000-8000-000000001501', 2,
  '00000000-0000-4000-8000-000000001513', 'social', 'social_monitoring_x')
  FROM refunded;
SELECT public.refund_credits_once('social:' || run_id::text || ':refund',
  '00000000-0000-4000-8000-000000001501', 2,
  '00000000-0000-4000-8000-000000001513', 'social', 'social_monitoring_x')
  FROM refunded;
SELECT is(
  (SELECT balance FROM public.credit_accounts
    WHERE user_id = '00000000-0000-4000-8000-000000001501'),
  96, 'setup: three charges, one already refunded'
);

-- Runs were created long ago (queue wait), but parked just now: not stalled.
UPDATE public.scout_runs SET started_at = now() - interval '3 hours'
 WHERE id IN (SELECT run_id FROM claimed);
SELECT public.reconcile_waiting_scout_dispatches();
SELECT is(
  (SELECT count(*) FROM public.scout_runs
    WHERE status = 'running' AND id IN (SELECT run_id FROM claimed)),
  4::bigint, 'a run is judged from its park time, not its creation time'
);

-- Workers of three runs died 31 minutes ago; one is still inside its window.
UPDATE public.scout_dispatch_queue SET updated_at = now() - interval '31 minutes'
 WHERE scout_run_id IN (
   SELECT run_id FROM dead UNION SELECT run_id FROM refunded
   UNION SELECT run_id FROM uncharged
 );
SELECT is(public.reconcile_waiting_scout_dispatches(), 3,
  'three social runs past the worker lifetime are reconciled');
SELECT is(
  (SELECT status || ':' || error_class FROM public.scout_runs
    WHERE id = (SELECT run_id FROM dead)),
  'error:platform', 'a social run whose worker died becomes terminal'
);
SELECT is(
  (SELECT status FROM public.scout_dispatch_queue
    WHERE scout_run_id = (SELECT run_id FROM dead)),
  'failed', 'a stalled social run releases its queue slot'
);
SELECT is(
  (SELECT count(*) FROM public.usage_records
    WHERE idempotency_key = 'social:' || (SELECT run_id FROM dead)::text || ':refund'),
  1::bigint, 'the stalled run is refunded once, under the refund key'
);
SELECT is(
  (SELECT balance FROM public.credit_accounts
    WHERE user_id = '00000000-0000-4000-8000-000000001501'),
  98, 'refund restores the charge read from usage_records (cost 2)'
);
SELECT is(
  (SELECT count(*) FROM public.usage_records
    WHERE idempotency_key = 'social:' || (SELECT run_id FROM refunded)::text || ':refund'),
  1::bigint, 'a run whose worker already refunded is not refunded again'
);
SELECT is(
  (SELECT count(*) FROM public.usage_records
    WHERE idempotency_key = 'social:' || (SELECT run_id FROM uncharged)::text || ':refund'),
  0::bigint, 'a run with no charge record is closed without a refund'
);
SELECT is(
  (SELECT status FROM public.scout_runs WHERE id = (SELECT run_id FROM alive)),
  'running', 'a social run still inside the worker lifetime is left alone'
);
SELECT is(public.reconcile_waiting_scout_dispatches(), 0,
  'a second pass changes nothing and refunds nothing more');

SELECT * FROM finish();
ROLLBACK;
