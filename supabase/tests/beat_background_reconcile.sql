BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(4);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000001291',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'beat-background@example.test', '',
  now(), now(), now()
);
INSERT INTO public.scouts (
  id, user_id, name, type, is_active, schedule_cron
) VALUES
  ('00000000-0000-4000-8000-000000001292', '00000000-0000-4000-8000-000000001291', 'Beat stalled', 'beat', true, '1 8 * * *'),
  ('00000000-0000-4000-8000-000000001293', '00000000-0000-4000-8000-000000001291', 'Beat working', 'beat', true, '2 8 * * *');

-- Both runs answered the dispatcher 202 and were parked as waiting.
CREATE TEMP TABLE stalled AS
SELECT * FROM public.enqueue_scout_dispatch(
  '00000000-0000-4000-8000-000000001292', NULL, 'scheduled', 0
);
CREATE TEMP TABLE working AS
SELECT * FROM public.enqueue_scout_dispatch(
  '00000000-0000-4000-8000-000000001293', NULL, 'scheduled', 0
);
CREATE TEMP TABLE claimed AS
SELECT * FROM public.claim_scout_dispatch_batch('beat-worker', 3, 3, 900, 3);
SELECT public.park_scout_dispatch(queue_id, 'beat-worker') FROM claimed;
UPDATE public.scout_runs SET status = 'running',
       started_at = now() - interval '31 minutes'
 WHERE id = (SELECT run_id FROM stalled);
UPDATE public.scout_runs SET status = 'running', started_at = now()
 WHERE id = (SELECT run_id FROM working);

SELECT is(public.reconcile_waiting_scout_dispatches(), 1,
  'only the Beat run past the worker lifetime is reconciled');
SELECT is(
  (SELECT status || ':' || error_class FROM public.scout_runs
    WHERE id = (SELECT run_id FROM stalled)),
  'error:platform', 'Beat run whose worker died becomes terminal'
);
SELECT is(
  (SELECT status FROM public.scout_dispatch_queue
    WHERE scout_run_id = (SELECT run_id FROM stalled)),
  'failed', 'stalled Beat run releases its queue slot'
);
SELECT is(
  (SELECT status FROM public.scout_runs
    WHERE id = (SELECT run_id FROM working)),
  'running', 'a Beat run still inside the worker lifetime is left alone'
);

SELECT * FROM finish();
ROLLBACK;
