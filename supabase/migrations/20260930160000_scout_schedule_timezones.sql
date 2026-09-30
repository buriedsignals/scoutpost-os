-- Keep cron/time/day in the scout's wall-clock timezone. UTC jobs retain native
-- pg_cron semantics, including arbitrary expressions and the existing spread.
-- Non-UTC jobs tick once a minute; only a due local slot enqueues a request.

CREATE OR REPLACE FUNCTION public.validate_scout_schedule(
  p_cron_expr text,
  p_timezone text
)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_parts text[];
BEGIN
  IF p_timezone IS NULL OR NOT (
    p_timezone = 'UTC' OR position('/' IN p_timezone) > 0
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_timezone_names WHERE lower(name) = lower(p_timezone)
  ) THEN
    RAISE EXCEPTION 'schedule_timezone must be a valid IANA timezone (or UTC)'
      USING ERRCODE = '22023';
  END IF;
  IF p_cron_expr IS NULL OR p_timezone = 'UTC' THEN
    RETURN;
  END IF;

  v_parts := regexp_split_to_array(trim(p_cron_expr), E'\\s+');
  -- Deliberately not a second general cron engine. Support the schedules made
  -- by the product (including anchored transport hour lists). Arbitrary UTC
  -- expressions continue to be parsed and executed by pg_cron itself.
  IF array_length(v_parts, 1) <> 5
    OR v_parts[1] !~ '^[0-5]?[0-9]$'
    OR v_parts[2] !~ '^([01]?[0-9]|2[0-3])(,([01]?[0-9]|2[0-3]))*$'
    OR v_parts[3] !~ '^(\*|[1-9]|[12][0-9]|3[01])$'
    OR v_parts[4] <> '*'
    OR v_parts[5] !~ '^(\*|[0-7])$'
    OR (v_parts[3] <> '*' AND v_parts[5] <> '*')
  THEN
    RAISE EXCEPTION 'non-UTC schedules require fixed minute, fixed/list hours, and daily, weekly, or monthly day fields; use UTC for arbitrary cron'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_scout_schedule_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- NULL was historically equivalent to UTC; never reinterpret existing rows.
  NEW.schedule_timezone := COALESCE(NEW.schedule_timezone, 'UTC');
  PERFORM public.validate_scout_schedule(NEW.schedule_cron, NEW.schedule_timezone);
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_scout_schedule_before_write
BEFORE INSERT OR UPDATE OF schedule_cron, schedule_timezone ON public.scouts
FOR EACH ROW EXECUTE FUNCTION public.validate_scout_schedule_row();

CREATE OR REPLACE FUNCTION public.scout_schedule_due(
  p_cron_expr text,
  p_timezone text,
  p_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
STRICT
SET search_path = public
AS $$
DECLARE
  v_local timestamp := date_trunc('minute', p_at AT TIME ZONE p_timezone);
  v_parts text[] := regexp_split_to_array(trim(p_cron_expr), E'\\s+');
BEGIN
  -- The row trigger and schedule_scout validate grammar/tzdata once on writes;
  -- avoid scanning pg_timezone_names on every minute tick.
  -- Missing local times have no corresponding tick and are skipped. For a
  -- repeated local time, PostgreSQL resolves AT TIME ZONE to its standard-time
  -- occurrence (the later occurrence in America/New_York). Only that tick can
  -- claim the slot, even after pause/resume or a schedule update during a fold.
  IF v_local AT TIME ZONE p_timezone <> date_trunc('minute', p_at) THEN
    RETURN false;
  END IF;
  RETURN extract(minute FROM v_local)::int = v_parts[1]::int
    AND extract(hour FROM v_local)::int = ANY(string_to_array(v_parts[2], ',')::int[])
    AND CASE WHEN v_parts[3] = '*' THEN true ELSE v_parts[3]::int = extract(day FROM v_local)::int END
    AND CASE WHEN v_parts[5] = '*' THEN true ELSE v_parts[5]::int % 7 = extract(dow FROM v_local)::int END;
END;
$$;

-- One high-water mark per scout, not an unbounded dispatch ledger.
-- The scheduler's claim and pg_net enqueue share a transaction.
ALTER TABLE public.scouts ADD COLUMN schedule_last_dispatched_at timestamptz;

CREATE OR REPLACE FUNCTION public.claim_scout_schedule(
  p_scout_id uuid,
  p_at timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_minute timestamptz := date_trunc('minute', p_at);
BEGIN
  -- UPDATE takes a row lock only for a due slot. Concurrent claimers recheck
  -- the high-water mark after waiting, so exactly one can enqueue that minute.
  UPDATE public.scouts s SET schedule_last_dispatched_at = v_minute
   WHERE s.id = p_scout_id AND s.is_active
     AND (s.schedule_last_dispatched_at IS NULL OR s.schedule_last_dispatched_at < v_minute)
     AND CASE WHEN COALESCE(s.schedule_timezone, 'UTC') = 'UTC' OR s.schedule_cron IS NULL
       THEN false
       ELSE public.scout_schedule_due(
         public.effective_scout_cron(s.id, s.schedule_cron,
           lower(COALESCE(s.metadata->>'exact_schedule', 'false')) IN ('true', '1', 'yes')),
         s.schedule_timezone, p_at)
       END;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.dispatch_scout_schedule(p_scout_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url text;
  v_key text;
BEGIN
  IF NOT public.claim_scout_schedule(p_scout_id) THEN
    RETURN;
  END IF;
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'internal_service_key';
  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE EXCEPTION 'vault secrets project_url / internal_service_key must be set before scheduling scouts';
  END IF;
  PERFORM net.http_post(
    url := v_url || '/functions/v1/execute-scout',
    headers := jsonb_build_object('X-Service-Key', v_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('scout_id', p_scout_id::text)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.schedule_scout(p_scout_id uuid, p_cron_expr text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  job_name text := 'scout-' || p_scout_id::text;
  http_cmd text;
  v_scout public.scouts%ROWTYPE;
  effective_expr text;
BEGIN
  SELECT * INTO STRICT v_scout FROM public.scouts WHERE id = p_scout_id FOR UPDATE;
  PERFORM public.validate_scout_schedule(p_cron_expr, COALESCE(v_scout.schedule_timezone, 'UTC'));
  IF NOT v_scout.is_active OR v_scout.schedule_cron IS DISTINCT FROM p_cron_expr THEN
    RAISE EXCEPTION 'schedule_scout requires an active scout with the matching stored cron'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
    OR NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key')
  THEN
    RAISE EXCEPTION 'vault secrets project_url / internal_service_key must be set before scheduling scouts';
  END IF;

  effective_expr := public.effective_scout_cron(p_scout_id, p_cron_expr,
    lower(COALESCE(v_scout.metadata->>'exact_schedule', 'false')) IN ('true', '1', 'yes'));

  IF COALESCE(v_scout.schedule_timezone, 'UTC') = 'UTC' THEN
    http_cmd := format(
      $fmt$SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/execute-scout',
        headers := jsonb_build_object(
          'X-Service-Key', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_service_key'),
          'Content-Type', 'application/json'
        ),
        body := jsonb_build_object('scout_id', %L::text)
      )
      WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
        AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key')$fmt$,
      p_scout_id
    );
  ELSE
    http_cmd := format('SELECT public.dispatch_scout_schedule(%L::uuid)', p_scout_id);
  END IF;

  -- cron.schedule upserts named jobs; invalid expressions roll back atomically.
  PERFORM cron.schedule(job_name,
    CASE WHEN COALESCE(v_scout.schedule_timezone, 'UTC') = 'UTC' THEN effective_expr ELSE '* * * * *' END,
    http_cmd);
  UPDATE public.scouts
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
       'effective_schedule_cron', effective_expr,
       'schedule_spread_minutes', CASE WHEN effective_expr = p_cron_expr THEN 0
         ELSE split_part(effective_expr, ' ', 1)::int END
     )
   WHERE id = p_scout_id;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_scout_schedule(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_scout_schedule_row() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.scout_schedule_due(text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_scout_schedule(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dispatch_scout_schedule(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.schedule_scout(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_scout_schedule(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.scout_schedule_due(text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_scout_schedule(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.dispatch_scout_schedule(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.schedule_scout(uuid, text) TO service_role;

-- Do not touch existing UTC jobs. Unsupported stored non-UTC schedules fail
-- explicitly during migration rather than silently reverting to UTC.
DO $$
DECLARE
  v_scout record;
BEGIN
  FOR v_scout IN SELECT id, schedule_cron, schedule_timezone FROM public.scouts
    WHERE COALESCE(schedule_timezone, 'UTC') <> 'UTC'
  LOOP
    PERFORM public.validate_scout_schedule(v_scout.schedule_cron, v_scout.schedule_timezone);
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'scout-' || v_scout.id::text) THEN
      PERFORM public.schedule_scout(v_scout.id, v_scout.schedule_cron);
    END IF;
  END LOOP;
END;
$$;
