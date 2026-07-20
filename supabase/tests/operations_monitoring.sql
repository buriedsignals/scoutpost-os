BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(8);

SELECT has_table('public', 'operator_incidents',
  'operator incident state is durable');

CREATE TEMP TABLE opened AS
SELECT * FROM public.record_operator_incident(
  'dispatch_queue_delay', 'dispatch_queue_delay', true, 'warning',
  'oldest item waited 12 minutes', '{"queued_count":12}'::jsonb, 21600
);
SELECT is((SELECT should_notify FROM opened), true,
  'a new active incident requests notification');
SELECT is((SELECT transition FROM opened), 'opened',
  'a new incident records the opened transition');

DO $$
BEGIN
  PERFORM public.ack_operator_incident_notifications(ARRAY['dispatch_queue_delay']);
END;
$$;

CREATE TEMP TABLE unchanged AS
SELECT * FROM public.record_operator_incident(
  'dispatch_queue_delay', 'dispatch_queue_delay', true, 'warning',
  'oldest item waited 13 minutes', '{"queued_count":13}'::jsonb, 21600
);
SELECT is((SELECT should_notify FROM unchanged), false,
  'an unchanged active incident is deduplicated during cooldown');

UPDATE public.operator_incidents
   SET last_notified_at = now() - interval '7 hours'
 WHERE incident_key = 'dispatch_queue_delay';
CREATE TEMP TABLE reminder AS
SELECT * FROM public.record_operator_incident(
  'dispatch_queue_delay', 'dispatch_queue_delay', true, 'critical',
  'oldest item waited 45 minutes', '{"queued_count":30}'::jsonb, 21600
);
SELECT is((SELECT transition FROM reminder), 'reminder',
  'a persistent incident reminds after cooldown');

CREATE TEMP TABLE resolved AS
SELECT * FROM public.record_operator_incident(
  'dispatch_queue_delay', 'dispatch_queue_delay', false, 'warning',
  'queue delay is within threshold', '{}'::jsonb, 21600
);
SELECT is((SELECT transition FROM resolved), 'resolved',
  'a recovered incident emits one resolved transition');

CREATE TEMP TABLE recovery_retry AS
SELECT * FROM public.record_operator_incident(
  'dispatch_queue_delay', 'dispatch_queue_delay', false, 'warning',
  'queue delay is within threshold', '{}'::jsonb, 21600
);
SELECT is((SELECT should_notify FROM recovery_retry), true,
  'an unacknowledged recovery notification is retried');

DO $$
BEGIN
  PERFORM public.ack_operator_incident_notifications(ARRAY['dispatch_queue_delay']);
END;
$$;

CREATE TEMP TABLE healthy_again AS
SELECT * FROM public.record_operator_incident(
  'dispatch_queue_delay', 'dispatch_queue_delay', false, 'warning',
  'queue delay is within threshold', '{}'::jsonb, 21600
);
SELECT is((SELECT should_notify FROM healthy_again), false,
  'repeated healthy observations stay silent');

SELECT * FROM finish();
ROLLBACK;
