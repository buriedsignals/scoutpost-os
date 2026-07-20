BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(8);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000931',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'dispatch-load@example.test', '',
  now(), now(), now()
);

CREATE TEMP TABLE dispatch_load_results (
  scale int PRIMARY KEY,
  claimed int NOT NULL,
  iterations int NOT NULL,
  max_leased int NOT NULL,
  remaining int NOT NULL,
  max_attempts int NOT NULL
);
CREATE TEMP TABLE dispatch_load_claims (
  queue_id uuid,
  run_id uuid,
  scout_id uuid,
  user_id uuid,
  scout_type text,
  source text,
  attempt int
);

CREATE FUNCTION pg_temp.run_dispatch_load(p_scale int)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_index int;
  v_claimed int := 0;
  v_iterations int := 0;
  v_max_leased int := 0;
  v_batch int;
  v_claim record;
  v_scout_id uuid;
BEGIN
  FOR v_index IN 1..p_scale LOOP
    v_scout_id := (
      '10000000-0000-4000-8000-' ||
      lpad((p_scale * 1000 + v_index)::text, 12, '0')
    )::uuid;
    INSERT INTO public.scouts (
      id, user_id, name, type, is_active, schedule_cron
    ) VALUES (
      v_scout_id,
      '00000000-0000-4000-8000-000000000931',
      format('Load %s / %s', p_scale, v_index),
      CASE v_index % 3 WHEN 0 THEN 'civic' WHEN 1 THEN 'web' ELSE 'beat' END,
      true,
      '0 8 * * *'
    );
    PERFORM public.enqueue_scout_dispatch(v_scout_id, NULL, 'scheduled', 0);
  END LOOP;

  LOOP
    TRUNCATE dispatch_load_claims;
    INSERT INTO dispatch_load_claims
    SELECT * FROM public.claim_scout_dispatch_batch(
      format('load-%s-%s', p_scale, v_iterations), 3, 3, 900, 3
    );
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    EXIT WHEN v_batch = 0;
    v_iterations := v_iterations + 1;
    v_claimed := v_claimed + v_batch;
    v_max_leased := GREATEST(
      v_max_leased,
      (SELECT count(*)::int FROM public.scout_dispatch_queue WHERE status = 'leased')
    );
    UPDATE public.scout_runs
       SET status = 'success', completed_at = now()
     WHERE id IN (SELECT run_id FROM dispatch_load_claims);
    FOR v_claim IN SELECT * FROM dispatch_load_claims LOOP
      PERFORM public.finish_scout_dispatch(
        v_claim.queue_id,
        format('load-%s-%s', p_scale, v_iterations - 1),
        true,
        NULL,
        NULL
      );
    END LOOP;
  END LOOP;

  INSERT INTO dispatch_load_results
  SELECT
    p_scale,
    v_claimed,
    v_iterations,
    v_max_leased,
    count(*) FILTER (WHERE status IN ('queued', 'leased'))::int,
    COALESCE(max(attempts), 0)::int
  FROM public.scout_dispatch_queue q
  JOIN public.scouts s ON s.id = q.scout_id
  WHERE s.name LIKE format('Load %s / %%', p_scale);
END;
$$;

SELECT pg_temp.run_dispatch_load(60);
SELECT is((SELECT claimed FROM dispatch_load_results WHERE scale = 60), 60,
  '60-scout gate drains every queued run');
SELECT is((SELECT iterations FROM dispatch_load_results WHERE scale = 60), 20,
  '60-scout gate drains in twenty capacity-three batches');
SELECT is((SELECT max_leased FROM dispatch_load_results WHERE scale = 60), 3,
  '60-scout gate never exceeds global capacity three');
SELECT is((SELECT remaining FROM dispatch_load_results WHERE scale = 60), 0,
  '60-scout gate leaves no active queue rows');

SELECT pg_temp.run_dispatch_load(120);
SELECT is((SELECT claimed FROM dispatch_load_results WHERE scale = 120), 120,
  '120-scout gate drains every queued run');
SELECT is((SELECT iterations FROM dispatch_load_results WHERE scale = 120), 40,
  '120-scout gate drains in forty capacity-three batches');
SELECT is((SELECT max_leased FROM dispatch_load_results WHERE scale = 120), 3,
  '120-scout gate never exceeds global capacity three');
SELECT is((SELECT max_attempts FROM dispatch_load_results WHERE scale = 120), 1,
  '120-scout gate completes without lease retries');

SELECT * FROM finish();
ROLLBACK;
