CREATE OR REPLACE FUNCTION public.revoke_current_api_key(p_key text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_id uuid;
BEGIN
  DELETE FROM public.api_keys
    WHERE key_hash = encode(digest(p_key, 'sha256'), 'hex')
    RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
