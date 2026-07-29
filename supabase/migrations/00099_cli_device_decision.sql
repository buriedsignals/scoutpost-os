CREATE OR REPLACE FUNCTION public.decide_cli_device_authorization(
  p_user_code_hash text,
  p_user_id uuid,
  p_decision text
)
RETURNS TABLE(result text, request_id uuid, key_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_request public.cli_device_authorizations%ROWTYPE;
  v_key_count integer := 0;
BEGIN
  IF p_decision NOT IN ('approve', 'deny') THEN
    RAISE EXCEPTION 'invalid decision';
  END IF;

  SELECT * INTO v_request
  FROM public.cli_device_authorizations
  WHERE user_code_hash = p_user_code_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, 0;
    RETURN;
  END IF;
  IF v_request.expires_at <= clock_timestamp() THEN
    UPDATE public.cli_device_authorizations
      SET status = 'expired'
      WHERE id = v_request.id AND status IN ('pending', 'approved');
    RETURN QUERY SELECT 'expired'::text, v_request.id, 0;
    RETURN;
  END IF;
  IF v_request.status <> 'pending' THEN
    RETURN QUERY SELECT v_request.status, v_request.id, 0;
    RETURN;
  END IF;

  IF p_decision = 'approve' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('api-key:' || p_user_id::text, 0));
    SELECT count(*)::integer INTO v_key_count
      FROM public.api_keys WHERE user_id = p_user_id;
    IF v_key_count >= 5 THEN
      RETURN QUERY SELECT 'key_limit_reached'::text, v_request.id, v_key_count;
      RETURN;
    END IF;
    UPDATE public.cli_device_authorizations
      SET status = 'approved', approved_by = p_user_id, decided_at = clock_timestamp()
      WHERE id = v_request.id;
    RETURN QUERY SELECT 'approved'::text, v_request.id, v_key_count;
  ELSE
    UPDATE public.cli_device_authorizations
      SET status = 'denied', approved_by = p_user_id, decided_at = clock_timestamp()
      WHERE id = v_request.id;
    RETURN QUERY SELECT 'denied'::text, v_request.id, 0;
  END IF;
END;
$$;
