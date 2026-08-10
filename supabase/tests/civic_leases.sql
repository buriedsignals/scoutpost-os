BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(38);

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
    '00000000-0000-4000-8000-000000000914', 'worker-two',
    '00000000-0000-4000-8000-000000000999', 1, 0, NULL
  ),
  false,
  'a queue row cannot finalize an unrelated run identifier'
);
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

-- A run may only settle after every expected document has reached a terminal
-- state. This guards the first-document-wins alert truncation regression.
INSERT INTO public.scout_runs (id, scout_id, user_id, status)
VALUES (
  '00000000-0000-4000-8000-000000000917',
  '00000000-0000-4000-8000-000000000912',
  '00000000-0000-4000-8000-000000000911',
  'running'
);
INSERT INTO public.civic_extraction_queue (
  id, user_id, scout_id, scout_run_id, source_url, doc_kind, status,
  attempts, lease_owner, lease_expires_at, heartbeat_at
) VALUES
(
  '00000000-0000-4000-8000-000000000918',
  '00000000-0000-4000-8000-000000000911',
  '00000000-0000-4000-8000-000000000912',
  '00000000-0000-4000-8000-000000000917',
  'https://example.test/first', 'html', 'processing', 1,
  'worker-three', now() + interval '5 minutes', now()
),
(
  '00000000-0000-4000-8000-000000000919',
  '00000000-0000-4000-8000-000000000911',
  '00000000-0000-4000-8000-000000000912',
  '00000000-0000-4000-8000-000000000917',
  'https://example.test/second', 'html', 'processing', 1,
  'worker-four', now() + interval '5 minutes', now()
);
SELECT is(
  public.finalize_civic_run_doc(
    '00000000-0000-4000-8000-000000000918', 'worker-three',
    '00000000-0000-4000-8000-000000000917', 1, 0, NULL
  ), true,
  'first document finalizes independently'
);
SELECT is(
  (SELECT status FROM public.scout_runs WHERE id = '00000000-0000-4000-8000-000000000917'),
  'running',
  'first terminal document does not settle a multi-document run'
);
SELECT is(
  public.finalize_civic_run_doc(
    '00000000-0000-4000-8000-000000000919', 'worker-four',
    '00000000-0000-4000-8000-000000000917', 2, 1, NULL
  ), true,
  'second document finalizes independently'
);
SELECT is(
  (SELECT status FROM public.scout_runs WHERE id = '00000000-0000-4000-8000-000000000917'),
  'success',
  'run settles only after its final document'
);

-- Due reminders are delivery state, not a lifecycle status. An overdue
-- in-progress promise is eligible once, is caught up, and retains its human
-- editorial state after delivery.
INSERT INTO public.promises (
  id, user_id, scout_id, promise_text, source_url, due_date,
  date_confidence, status
) VALUES (
  '00000000-0000-4000-8000-000000000920',
  '00000000-0000-4000-8000-000000000911',
  '00000000-0000-4000-8000-000000000912',
  'Publish the overdue audit', 'https://example.test/audit',
  current_date - 1, 'high', 'in_progress'
);
CREATE TEMP TABLE claimed_reminder AS
SELECT * FROM public.claim_due_promise_reminders(
  'digest-worker', current_date, 10, 60
);
SELECT is((SELECT count(*) FROM claimed_reminder), 1::bigint,
  'overdue open promise is claimed for catch-up reminder');
SELECT is(
  public.finalize_due_promise_reminders(
    'digest-worker',
    ARRAY[(SELECT delivery_id FROM claimed_reminder)],
    true,
    NULL
  ),
  1,
  'claimed reminder finalizes exactly once'
);
SELECT is(
  (SELECT status FROM public.promises WHERE id = '00000000-0000-4000-8000-000000000920'),
  'in_progress',
  'reminder delivery preserves the human lifecycle status'
);
SELECT ok(
  (SELECT due_notified_at IS NOT NULL FROM public.promises
    WHERE id = '00000000-0000-4000-8000-000000000920'),
  'successful reminder records delivery separately'
);
SELECT is(
  (SELECT count(*) FROM public.claim_due_promise_reminders(
    'digest-worker-two', current_date, 10, 60
  )),
  0::bigint,
  'delivered deadline is not claimed a second time'
);

-- A crash after provider acceptance is reconciled under a new worker lease;
-- it must not construct another provider submission for the same deadline.
INSERT INTO public.promises (
  id, user_id, scout_id, promise_text, source_url, due_date,
  date_confidence, status
) VALUES (
  '00000000-0000-4000-8000-000000000921',
  '00000000-0000-4000-8000-000000000911',
  '00000000-0000-4000-8000-000000000912',
  'Publish a reconciled audit', 'https://example.test/reconciled-audit',
  current_date, 'high', 'new'
);
CREATE TEMP TABLE accepted_reminder AS
SELECT * FROM public.claim_due_promise_reminders(
  'acceptance-worker', current_date, 10, 60
);
SELECT is(
  public.mark_due_promise_reminders_provider_accepted(
    'acceptance-worker',
    ARRAY[(SELECT delivery_id FROM accepted_reminder)],
    'provider-accepted-id'
  ),
  1,
  'provider acceptance is durably recorded before finalization'
);
CREATE TEMP TABLE reconciled_reminder AS
SELECT * FROM public.claim_due_promise_reminders(
  'reconcile-worker', current_date, 10, 60
);
SELECT is((SELECT count(*) FROM reconciled_reminder), 1::bigint,
  'provider-accepted reminder is reclaimed for reconciliation');
SELECT is(
  (SELECT needs_provider_submission FROM reconciled_reminder), false,
  'reconciled reminder must not submit a second provider request'
);
SELECT is(
  public.finalize_due_promise_reminders(
    'reconcile-worker',
    ARRAY[(SELECT delivery_id FROM reconciled_reminder)],
    true,
    NULL
  ),
  1,
  'reconciled provider-accepted reminder finalizes under its new lease'
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

-- A settled scheduled Civic run receives exactly one durable alert delivery.
INSERT INTO public.information_units (id, user_id, scout_id, scout_type, statement, type)
VALUES (
  '00000000-0000-4000-8000-000000000930',
  '00000000-0000-4000-8000-000000000911',
  '00000000-0000-4000-8000-000000000912', 'civic', 'Publish the lease audit', 'fact'
);
INSERT INTO public.scout_runs (id, scout_id, user_id, status)
VALUES ('00000000-0000-4000-8000-000000000931',
  '00000000-0000-4000-8000-000000000912', '00000000-0000-4000-8000-000000000911', 'running');
INSERT INTO public.civic_extraction_queue (id, user_id, scout_id, scout_run_id, source_url, doc_kind, status, ingestion_mode)
VALUES ('00000000-0000-4000-8000-000000000932',
  '00000000-0000-4000-8000-000000000911', '00000000-0000-4000-8000-000000000912',
  '00000000-0000-4000-8000-000000000931', 'https://example.test/alert', 'html', 'done', 'scheduled');
INSERT INTO public.civic_run_alert_items (scout_run_id, queue_id, user_id, unit_id, statement, source_url)
VALUES ('00000000-0000-4000-8000-000000000931', '00000000-0000-4000-8000-000000000932',
  '00000000-0000-4000-8000-000000000911', '00000000-0000-4000-8000-000000000930',
  'Publish the lease audit', 'https://example.test/alert');
UPDATE public.scout_runs SET status = 'success' WHERE id = '00000000-0000-4000-8000-000000000931';
SELECT is((SELECT provider_idempotency_key FROM public.civic_run_alert_deliveries
  WHERE scout_run_id = '00000000-0000-4000-8000-000000000931'),
  'civic/00000000-0000-4000-8000-000000000931/new-items',
  'settlement seals one stable run-alert provider key');
CREATE TEMP TABLE alert_claim AS SELECT * FROM public.claim_civic_run_alert_delivery(
  '00000000-0000-4000-8000-000000000931', 'alert-worker', 60);
SELECT is((SELECT count(*) FROM alert_claim), 1::bigint, 'alert delivery is claimed once');
SELECT ok((SELECT needs_provider_submission FROM alert_claim), 'fresh alert claim submits to provider');
SELECT ok(public.mark_civic_run_alert_provider_accepted(
  (SELECT delivery_id FROM alert_claim), 'alert-worker', (SELECT fencing_token FROM alert_claim), 'resend-1'),
  'provider acceptance is recorded before finalization');
CREATE TEMP TABLE reconciled_alert AS SELECT * FROM public.claim_civic_run_alert_delivery(
  '00000000-0000-4000-8000-000000000931', 'alert-reconciler', 60);
SELECT is((SELECT needs_provider_submission FROM reconciled_alert), false,
  'accepted alert is reconciled without another provider submission');
SELECT ok(public.finalize_civic_run_alert_delivery(
  (SELECT delivery_id FROM reconciled_alert), 'alert-reconciler', (SELECT fencing_token FROM reconciled_alert), 'sent'),
  'reconciled alert finalizes under its new fenced lease');

-- Historical repair is exact-target and cannot turn the Civic queue into a
-- broad re-extraction mechanism.
SELECT throws_ok(
  $$INSERT INTO public.civic_extraction_queue (
    id, user_id, scout_id, source_url, doc_kind, ingestion_mode
  ) VALUES (
    '00000000-0000-4000-8000-000000000940',
    '00000000-0000-4000-8000-000000000911',
    '00000000-0000-4000-8000-000000000912',
    'https://example.test/repair-missing-ledger', 'html', 'repair'
  )$$,
  'repair queue rows require an approved batch and exact item',
  'repair queue rejects work without an approved ledger item'
);
INSERT INTO public.civic_repair_batches (id, user_id, policy_version, status, operator_id, approved_at)
VALUES ('00000000-0000-4000-8000-000000000941',
  '00000000-0000-4000-8000-000000000911', 'civic-accountability-v2', 'approved',
  '00000000-0000-4000-8000-000000000911', now());
INSERT INTO public.civic_repair_batch_items (
  id, batch_id, target_unit_id, expected_content_sha256, proposed_classification,
  source_time_basis, status
) VALUES ('00000000-0000-4000-8000-000000000942',
  '00000000-0000-4000-8000-000000000941',
  '00000000-0000-4000-8000-000000000930', repeat('a', 64), 'rejected', now(), 'approved');
SELECT lives_ok(
  $$INSERT INTO public.civic_extraction_queue (
    id, user_id, scout_id, source_url, doc_kind, ingestion_mode, repair_batch_id, repair_batch_item_id
  ) VALUES (
    '00000000-0000-4000-8000-000000000943',
    '00000000-0000-4000-8000-000000000911',
    '00000000-0000-4000-8000-000000000912',
    'https://example.test/repair-exact-target', 'html', 'repair',
    '00000000-0000-4000-8000-000000000941', '00000000-0000-4000-8000-000000000942'
  )$$,
  'approved tenant-owned repair item can queue exact source work'
);

SELECT * FROM finish();
ROLLBACK;
