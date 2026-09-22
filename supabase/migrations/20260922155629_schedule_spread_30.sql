-- schedule_spread_30
-- Fan top-of-hour scout jobs across a 30-minute window instead of 15.
-- 2026-09-22: 230 of 251 active Page scouts run in the 08:00 UTC hour; a
-- 15-minute spread put ~15 starts on every minute and provider timeouts inside
-- that burst were counting as scout failures (#489). The offset stays derived
-- from the immutable UUID byte so every scout moves deterministically; the
-- user-facing schedule_cron and the exact_schedule opt-out are unchanged.
-- Plan: docs/plans/2026-09-22-1620-feat-crawler-scheduling-resilience-plan.md

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
  -- Single definition of the spread window; schedule_scout derives the
  -- recorded schedule_spread_minutes from the rewritten expression.
  c_spread_minutes constant int := 30;
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
  -- a stable 0..29 offset without depending on database hash implementation.
  v_offset := get_byte(uuid_send(p_scout_id), 15) % c_spread_minutes;
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

REVOKE ALL ON FUNCTION public.effective_scout_cron(uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;

-- Move the active fleet onto the wider window once. schedule_scout re-derives
-- metadata.effective_schedule_cron and schedule_spread_minutes per scout.
-- Same guard as 00084: local and self-hosted projects without the Vault
-- secrets that schedule_scout requires skip the reschedule safely.
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
