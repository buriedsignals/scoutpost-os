BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(10);

SELECT has_table(
  'public',
  'scout_dispatch_queue',
  'durable scout dispatch queue exists'
);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000871',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'dispatch-queue@example.test', '',
  now(), now(), now()
);

INSERT INTO public.scouts (
  id, user_id, name, type, is_active, schedule_cron
) VALUES
  ('00000000-0000-4000-8000-000000000872', '00000000-0000-4000-8000-000000000871', 'Queue Web A', 'web', true, '1 8 * * *'),
  ('00000000-0000-4000-8000-000000000873', '00000000-0000-4000-8000-000000000871', 'Queue Beat', 'beat', true, '2 8 * * *'),
  ('00000000-0000-4000-8000-000000000874', '00000000-0000-4000-8000-000000000871', 'Queue Civic', 'civic', true, '3 8 * * 1'),
  ('00000000-0000-4000-8000-000000000875', '00000000-0000-4000-8000-000000000871', 'Queue Web B', 'web', true, '4 8 * * *');

CREATE TEMP TABLE first_enqueue AS
SELECT * FROM public.enqueue_scout_dispatch(
  '00000000-0000-4000-8000-000000000872',
  NULL,
  'scheduled',
  0
);

SELECT is(
  (SELECT enqueued FROM first_enqueue),
  true,
  'first dispatch creates a queue row'
);

SELECT is(
  (
    SELECT stage
      FROM public.scout_runs
     WHERE id = (SELECT run_id FROM first_enqueue)
  ),
  'queued',
  'new run records its queued stage'
);

CREATE TEMP TABLE duplicate_enqueue AS
SELECT * FROM public.enqueue_scout_dispatch(
  '00000000-0000-4000-8000-000000000872',
  NULL,
  'scheduled',
  0
);

SELECT is(
  (SELECT enqueued FROM duplicate_enqueue),
  false,
  'duplicate active dispatch is coalesced'
);

SELECT is(
  (SELECT run_id FROM duplicate_enqueue),
  (SELECT run_id FROM first_enqueue),
  'coalesced dispatch returns the original run id'
);

DO $$
BEGIN
  PERFORM public.enqueue_scout_dispatch(
    '00000000-0000-4000-8000-000000000873', NULL, 'scheduled', 0
  );
  PERFORM public.enqueue_scout_dispatch(
    '00000000-0000-4000-8000-000000000874', NULL, 'scheduled', 0
  );
  PERFORM public.enqueue_scout_dispatch(
    '00000000-0000-4000-8000-000000000875', NULL, 'scheduled', 0
  );
END;
$$;

CREATE TEMP TABLE first_claim AS
SELECT * FROM public.claim_scout_dispatch_batch(
  'worker-one', 3, 3, 900, 3
);

SELECT is(
  (SELECT count(*) FROM first_claim),
  3::bigint,
  'first claimant leases exactly the global capacity'
);

SELECT is(
  (
    SELECT count(*)
      FROM public.claim_scout_dispatch_batch(
        'worker-overlap', 3, 3, 900, 3
      )
  ),
  0::bigint,
  'overlapping claimant cannot exceed occupied capacity'
);

UPDATE public.scout_runs
   SET status = 'success', completed_at = now()
 WHERE id = (SELECT run_id FROM first_claim ORDER BY run_id LIMIT 1);

SELECT is(
  public.finish_scout_dispatch(
    (SELECT queue_id FROM first_claim ORDER BY run_id LIMIT 1),
    'worker-one',
    true,
    NULL,
    NULL
  ),
  true,
  'lease owner can finish a dispatch'
);

CREATE TEMP TABLE second_claim AS
SELECT * FROM public.claim_scout_dispatch_batch(
  'worker-two', 3, 3, 900, 3
);

SELECT is(
  (SELECT count(*) FROM second_claim),
  1::bigint,
  'one freed slot admits exactly one queued run'
);

SELECT is(
  (
    SELECT count(*)
      FROM public.scout_dispatch_queue
     WHERE status = 'leased'
  ),
  3::bigint,
  'leased work remains at the configured ceiling'
);

SELECT * FROM finish();
ROLLBACK;
