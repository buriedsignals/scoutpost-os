CREATE OR REPLACE FUNCTION public.validate_api_key_identity(p_key text)
RETURNS TABLE(user_id uuid, key_id uuid, key_prefix text, key_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_hash text := encode(digest(p_key, 'sha256'), 'hex');
BEGIN
  RETURN QUERY
  UPDATE public.api_keys
    SET last_used_at = clock_timestamp()
    WHERE key_hash = v_hash
    RETURNING api_keys.user_id, api_keys.id, api_keys.key_prefix, api_keys.name;
END;
$$;
