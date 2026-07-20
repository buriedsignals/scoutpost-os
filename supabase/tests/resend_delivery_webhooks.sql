BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(17);

SELECT has_table('public', 'email_delivery_events',
  'Resend delivery events are stored durably');
SELECT hasnt_column('public', 'email_delivery_events', 'recipient_email',
  'delivery events do not persist raw recipient addresses');

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000921',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'delivery@example.test', '',
  now(), now(), now()
);
INSERT INTO public.scouts (id, user_id, name, type, is_active, schedule_cron)
VALUES (
  '00000000-0000-4000-8000-000000000922',
  '00000000-0000-4000-8000-000000000921',
  'Delivery Scout', 'web', true, '0 6 * * *'
);
INSERT INTO public.scout_runs (
  id, scout_id, user_id, status, notification_sent,
  notification_status, notification_provider_id
) VALUES (
  '00000000-0000-4000-8000-000000000923',
  '00000000-0000-4000-8000-000000000922',
  '00000000-0000-4000-8000-000000000921',
  'success', true, 'sent', 'email-provider-123'
);

CREATE TEMP TABLE delivered AS
SELECT * FROM public.record_resend_delivery_event(
  'msg-delivered', 'email-provider-123', 'email.delivered', 'delivered',
  '2026-07-20T20:00:00Z', 1, NULL, '{}'::jsonb
);
SELECT is((SELECT inserted FROM delivered), true,
  'first webhook event is inserted');
SELECT is((SELECT matched_run_id FROM delivered),
  '00000000-0000-4000-8000-000000000923'::uuid,
  'provider email id links the event to its scout run');
SELECT is((SELECT reconciled FROM delivered), true,
  'new delivery state reconciles the run');
SELECT is((SELECT notification_status FROM public.scout_runs
  WHERE id = '00000000-0000-4000-8000-000000000923'), 'delivered',
  'delivered event becomes the run delivery status');

SELECT is((SELECT inserted FROM public.record_resend_delivery_event(
  'msg-delivered', 'email-provider-123', 'email.delivered', 'delivered',
  '2026-07-20T20:00:00Z', 1, NULL, '{}'::jsonb
)), false, 'duplicate svix id is idempotent');

SELECT is((SELECT reconciled FROM public.record_resend_delivery_event(
  'msg-sent-late', 'email-provider-123', 'email.sent', 'sent',
  '2026-07-20T19:59:00Z', 1, NULL, '{}'::jsonb
)), false, 'out-of-order older event cannot downgrade delivery state');
SELECT is((SELECT notification_status FROM public.scout_runs
  WHERE id = '00000000-0000-4000-8000-000000000923'), 'delivered',
  'out-of-order sent event leaves delivered status intact');

SELECT is((SELECT reconciled FROM public.record_resend_delivery_event(
  'msg-bounced', 'email-provider-123', 'email.bounced', 'bounced',
  '2026-07-20T20:01:00Z', 1, 'mailbox does not exist',
  '{"bounce_type":"Permanent"}'::jsonb
)), true, 'newer bounce event reconciles the final delivery state');
SELECT is((SELECT notification_status FROM public.scout_runs
  WHERE id = '00000000-0000-4000-8000-000000000923'), 'bounced',
  'bounce status is visible on the run');
SELECT is(
  (SELECT count(*) FROM public.scout_run_events
    WHERE scout_run_id = '00000000-0000-4000-8000-000000000923'
      AND notification_status = 'bounced'),
  1::bigint,
  'a reconciled delivery transition is appended to run events'
);

INSERT INTO public.scout_runs (
  id, scout_id, user_id, status, notification_sent, notification_status
) VALUES (
  '00000000-0000-4000-8000-000000000924',
  '00000000-0000-4000-8000-000000000922',
  '00000000-0000-4000-8000-000000000921',
  'success', true, 'sent'
);
CREATE TEMP TABLE early_event AS
SELECT * FROM public.record_resend_delivery_event(
  'msg-early', 'email-provider-early', 'email.suppressed', 'suppressed',
  '2026-07-20T20:02:00Z', 1, 'recipient is on a suppression list',
  '{"suppression_type":"Suppressed"}'::jsonb
);
SELECT is((SELECT matched_run_id FROM early_event), NULL::uuid,
  'an event received before provider-id persistence is initially unmatched');
SELECT is((SELECT reconciled FROM early_event), false,
  'an initially unmatched event does not claim reconciliation');

UPDATE public.scout_runs
   SET notification_provider_id = 'email-provider-early'
 WHERE id = '00000000-0000-4000-8000-000000000924';

SELECT is((SELECT notification_status FROM public.scout_runs
  WHERE id = '00000000-0000-4000-8000-000000000924'), 'suppressed',
  'provider-id persistence reconciles an earlier delivery event');
SELECT is((SELECT scout_run_id FROM public.email_delivery_events
  WHERE svix_id = 'msg-early'),
  '00000000-0000-4000-8000-000000000924'::uuid,
  'the earlier delivery ledger row is linked to the run');
SELECT is(
  (SELECT count(*) FROM public.scout_run_events
    WHERE scout_run_id = '00000000-0000-4000-8000-000000000924'
      AND notification_status = 'suppressed'),
  1::bigint,
  'late reconciliation appends the suppressed transition to run events'
);

SELECT * FROM finish();
ROLLBACK;
