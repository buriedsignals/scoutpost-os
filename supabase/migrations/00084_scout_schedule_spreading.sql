-- 00084_scout_schedule_spreading.sql
-- Spread synchronized top-of-hour scout jobs across a deterministic 15-minute
-- window. The user-facing schedule_cron remains the requested wall-clock
-- schedule; scouts.metadata.effective_schedule_cron records the pg_cron value.
-- Operators can set metadata.exact_schedule=true to opt a time-critical scout
-- out of spreading.

CREATE OR REPLACE FUNCTION public.effective_scout_cron(
  p_scout_id uuid,
  p_cron_expr text,
  p_exact boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public
AS $$
DECLARE
  v_parts text[];
  v_hour int;
  v_offset int;
BEGIN
  IF p_exact THEN
    RETURN p_cron_expr;
  END IF;

  v_parts := regexp_split_to_array(trim(p_cron_expr), E'\\s+');
  -- Only rewrite ordinary five-field, top-of-hour schedules. Expressions with
  -- ranges, steps, lists, aliases, or a non-zero requested minute retain their
  -- exact semantics.
  IF array_length(v_parts, 1) <> 5
    OR v_parts[1] <> '0'
    OR v_parts[2] !~ '^(?:[0-9]|1[0-9]|2[0-3])$'
  THEN
    RETURN p_cron_expr;
  END IF;

  v_hour := v_parts[2]::int;
  -- UUID bytes are immutable and uniformly distributed. The final byte gives
  -- a stable 0..14 offset without depending on database hash implementation.
  v_offset := get_byte(uuid_send(p_scout_id), 15) % 15;
  RETURN format(
    '%s %s %s %s %s',
    v_offset,
    v_hour,
    v_parts[3],
    v_parts[4],
    v_parts[5]
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.schedule_scout(
  p_scout_id uuid,
  p_cron_expr text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  job_name text := 'scout-' || p_scout_id::text;
  http_cmd text;
  exact_schedule boolean := false;
  effective_expr text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url'
  ) OR NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key'
  ) THEN
    RAISE EXCEPTION 'vault secrets project_url / internal_service_key must be set before scheduling scouts';
  END IF;

  SELECT lower(COALESCE(s.metadata->>'exact_schedule', 'false')) IN
    ('true', '1', 'yes')
    INTO exact_schedule
    FROM public.scouts s
   WHERE s.id = p_scout_id;

  effective_expr := public.effective_scout_cron(
    p_scout_id,
    p_cron_expr,
    COALESCE(exact_schedule, false)
  );

  PERFORM cron.unschedule(job_name)
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = job_name);

  http_cmd := format(
    $fmt$SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/execute-scout',
      headers := jsonb_build_object(
        'X-Service-Key', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_service_key'),
        'Content-Type',  'application/json'
      ),
      body := jsonb_build_object('scout_id', %L::text)
    )
    WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
      AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key')$fmt$,
    p_scout_id
  );

  PERFORM cron.schedule(job_name, effective_expr, http_cmd);

  UPDATE public.scouts
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
       'effective_schedule_cron', effective_expr,
       'schedule_spread_minutes', CASE
         WHEN effective_expr = p_cron_expr THEN 0
         ELSE split_part(effective_expr, ' ', 1)::int
       END
     )
   WHERE id = p_scout_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.reschedule_active_scouts_with_spread(
  p_limit int DEFAULT 1000
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_scout record;
  v_count int := 0;
BEGIN
  FOR v_scout IN
    SELECT id, schedule_cron
      FROM public.scouts
     WHERE is_active = true
       AND schedule_cron IS NOT NULL
     ORDER BY id
     LIMIT GREATEST(0, LEAST(COALESCE(p_limit, 1000), 10000))
  LOOP
    PERFORM public.schedule_scout(v_scout.id, v_scout.schedule_cron);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.effective_scout_cron(uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_scout(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reschedule_active_scouts_with_spread(int)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.effective_scout_cron(uuid, text, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.schedule_scout(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reschedule_active_scouts_with_spread(int)
  TO service_role;

-- Apply the new effective schedule to the hosted fleet during migration. Local
-- and self-hosted projects without configured Vault secrets skip this safely.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url'
  ) AND EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key'
  ) THEN
    PERFORM public.reschedule_active_scouts_with_spread(10000);
  END IF;
END;
$$;
