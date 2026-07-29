CREATE OR REPLACE FUNCTION public.redeem_cli_device_authorization(
  p_device_code_hash text
)
RETURNS TABLE(result text, retry_after integer, api_key text, key_id uuid,
  key_prefix text, key_name text, user_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_request public.cli_device_authorizations%ROWTYPE;
  v_raw text;
  v_key public.api_keys%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_wait integer;
BEGIN
  SELECT * INTO v_request
  FROM public.cli_device_authorizations
  WHERE device_code_hash = p_device_code_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_grant'::text, 0, NULL::text, NULL::uuid,
      NULL::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;
  IF v_request.expires_at <= v_now THEN
    UPDATE public.cli_device_authorizations SET status = 'expired'
      WHERE id = v_request.id AND status IN ('pending', 'approved');
    RETURN QUERY SELECT 'expired_token'::text, 0, NULL::text, NULL::uuid,
      NULL::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;
  IF v_request.status = 'denied' THEN
    RETURN QUERY SELECT 'access_denied'::text, 0, NULL::text, NULL::uuid,
      NULL::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;
  IF v_request.status IN ('consumed', 'expired') THEN
    RETURN QUERY SELECT
      CASE WHEN v_request.status = 'expired' THEN 'expired_token' ELSE 'invalid_grant' END,
      0, NULL::text, NULL::uuid, NULL::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  IF v_request.last_polled_at IS NOT NULL THEN
    v_wait := ceil(extract(epoch FROM (
      v_request.last_polled_at +
      make_interval(secs => v_request.poll_interval_seconds) - v_now
    )))::integer;
    IF v_wait > 0 THEN
      UPDATE public.cli_device_authorizations
        SET poll_interval_seconds = LEAST(30, poll_interval_seconds + 5),
            last_polled_at = v_now, poll_count = poll_count + 1
        WHERE id = v_request.id;
      RETURN QUERY SELECT 'slow_down'::text,
        LEAST(30, v_request.poll_interval_seconds + 5),
        NULL::text, NULL::uuid, NULL::text, NULL::text, NULL::uuid;
      RETURN;
    END IF;
  END IF;

  UPDATE public.cli_device_authorizations
    SET last_polled_at = v_now, poll_count = poll_count + 1
    WHERE id = v_request.id;

  IF v_request.status = 'pending' THEN
    RETURN QUERY SELECT 'authorization_pending'::text,
      v_request.poll_interval_seconds, NULL::text, NULL::uuid,
      NULL::text, NULL::text, NULL::uuid;
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('api-key:' || v_request.approved_by::text, 0)
  );
  IF (
    SELECT count(*) FROM public.api_keys
    WHERE api_keys.user_id = v_request.approved_by
  ) >= 5 THEN
    RETURN QUERY SELECT 'api_key_limit_reached'::text, 0, NULL::text,
      NULL::uuid, NULL::text, NULL::text, v_request.approved_by;
    RETURN;
  END IF;

  v_raw := 'cj_' || rtrim(translate(encode(gen_random_bytes(18), 'base64'), '+/', '-_'), '=');
  INSERT INTO public.api_keys(
    user_id, key_hash, key_prefix, name, source, device_authorization_id
  )
  VALUES (
    v_request.approved_by, encode(digest(v_raw, 'sha256'), 'hex'),
    left(v_raw, 11),
    left(
      concat_ws(
        ' · ',
        'Scout CLI',
        nullif(v_request.agent_label, ''),
        nullif(v_request.device_label, '')
      ),
      100
    ),
    'cli_device', v_request.id
  )
  RETURNING * INTO v_key;

  UPDATE public.cli_device_authorizations
    SET status = 'consumed', consumed_at = v_now
    WHERE id = v_request.id;

  RETURN QUERY SELECT 'created'::text, 0, v_raw, v_key.id,
    v_key.key_prefix, v_key.name, v_request.approved_by;
END;
$$;
