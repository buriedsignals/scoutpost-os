BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(16);

SELECT has_column(
  'public', 'civic_extraction_queue', 'lease_expires_at',
  'Civic queue has an explicit lease expiry'
);
SELECT has_column(
  'public', 'civic_extraction_queue', 'heartbeat_at',
  'Civic queue records worker heartbeats'
);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000911',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'civic-lease@example.test', '',
  now(), now(), now()
);

INSERT INTO public.scouts (id, user_id, name, type, is_active, schedule_cron)
VALUES (
  '00000000-0000-4000-8000-000000000912',
  '00000000-0000-4000-8000-000000000911',
  'Civic Lease', 'civic', true, '0 6 * * *'
);
INSERT INTO public.scout_runs (id, scout_id, user_id, status)
VALUES (
  '00000000-0000-4000-8000-000000000913',
  '00000000-0000-4000-8000-000000000912',
  '00000000-0000-4000-8000-000000000911',
  'running'
);
INSERT INTO public.civic_extraction_queue (
  id, user_id, scout_id, scout_run_id, source_url, doc_kind
) VALUES (
  '00000000-0000-4000-8000-000000000914',
  '00000000-0000-4000-8000-000000000911',
  '00000000-0000-4000-8000-000000000912',
  '00000000-0000-4000-8000-000000000913',
  'https://example.test/lease', 'html'
);

CREATE TEMP TABLE first_civic_claim AS
SELECT * FROM public.claim_civic_queue_item('worker-one', NULL, 60, 3);

SELECT is((SELECT count(*) FROM first_civic_claim), 1::bigint,
  'first worker claims the pending row');
SELECT is((SELECT lease_owner FROM first_civic_claim), 'worker-one',
  'claim records the owning worker');
SELECT ok((SELECT heartbeat_at IS NOT NULL FROM first_civic_claim),
  'claim stamps its first heartbeat');
SELECT is(
  public.heartbeat_civic_queue_item(
    '00000000-0000-4000-8000-000000000914', 'wrong-worker', 60
  ),
  false,
  'a non-owner cannot extend the lease'
);
SELECT is(
  public.heartbeat_civic_queue_item(
    '00000000-0000-4000-8000-000000000914', 'worker-one', 60
  ),
  true,
  'the owner extends the live lease'
);

UPDATE public.civic_extraction_queue
   SET lease_expires_at = now() - interval '1 second'
 WHERE id = '00000000-0000-4000-8000-000000000914';

SELECT is(
  public.fail_civic_queue_item(
    '00000000-0000-4000-8000-000000000914', 'worker-one', 'too late', 3
  ),
  'lease_lost',
  'an owner cannot fail work after its lease expires'
);

CREATE TEMP TABLE reclaimed_civic_claim AS
SELECT * FROM public.claim_civic_queue_item('worker-two', NULL, 60, 3);

SELECT is((SELECT lease_owner FROM reclaimed_civic_claim), 'worker-two',
  'an expired lease is reclaimed by a new worker');
SELECT is((SELECT attempts FROM reclaimed_civic_claim), 2,
  'reclamation consumes the next bounded attempt');
SELECT is(
  public.finalize_civic_run_doc(
    '00000000-0000-4000-8000-000000000914', 'worker-one',
    '00000000-0000-4000-8000-000000000913', 1, 0, NULL
  ),
  false,
  'the stale worker cannot finalize reclaimed work'
);
SELECT is(
  public.finalize_civic_run_doc(
    '00000000-0000-4000-8000-000000000914', 'worker-two',
    '00000000-0000-4000-8000-000000000913', 1, 0, NULL
  ),
  true,
  'the current lease owner finalizes exactly once'
);
SELECT is(
  (SELECT status FROM public.civic_extraction_queue
    WHERE id = '00000000-0000-4000-8000-000000000914'),
  'done',
  'finalization terminalizes the queue row'
);
SELECT ok(
  (SELECT lease_owner IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL
     FROM public.civic_extraction_queue
    WHERE id = '00000000-0000-4000-8000-000000000914'),
  'terminal rows release all lease fields'
);

INSERT INTO public.scout_runs (id, scout_id, user_id, status)
VALUES (
  '00000000-0000-4000-8000-000000000915',
  '00000000-0000-4000-8000-000000000912',
  '00000000-0000-4000-8000-000000000911',
  'running'
);
INSERT INTO public.civic_extraction_queue (
  id, user_id, scout_id, scout_run_id, source_url, doc_kind, status,
  attempts, lease_owner, lease_expires_at, heartbeat_at
) VALUES (
  '00000000-0000-4000-8000-000000000916',
  '00000000-0000-4000-8000-000000000911',
  '00000000-0000-4000-8000-000000000912',
  '00000000-0000-4000-8000-000000000915',
  'https://example.test/exhausted', 'html', 'processing', 3,
  'lost-worker', now() - interval '1 second', now() - interval '2 minutes'
);
DO $$
BEGIN
  PERFORM public.civic_queue_failsafe(3);
END;
$$;
SELECT is(
  (SELECT status FROM public.civic_extraction_queue
    WHERE id = '00000000-0000-4000-8000-000000000916'),
  'failed',
  'failsafe terminalizes an expired final attempt'
);
SELECT is(
  (SELECT status FROM public.scout_runs
    WHERE id = '00000000-0000-4000-8000-000000000915'),
  'error',
  'failsafe terminalizes the linked run when no Civic work remains'
);

SELECT * FROM finish();
ROLLBACK;
