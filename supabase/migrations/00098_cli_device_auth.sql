-- Browser-assisted authentication for the Scout CLI.
--
-- Device and user codes are hashed before storage. An API key is generated
-- only when an approved request is redeemed, in the same transaction that
-- consumes the request. The per-user advisory lock makes the five-key limit
-- authoritative across manual creation and CLI redemption.

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'cli_device')),
  ADD COLUMN IF NOT EXISTS device_authorization_id uuid;

CREATE TABLE public.cli_device_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash text NOT NULL UNIQUE CHECK (length(device_code_hash) = 64),
  user_code_hash text NOT NULL UNIQUE CHECK (length(user_code_hash) = 64),
  site_origin text NOT NULL CHECK (length(site_origin) BETWEEN 8 AND 2048),
  client_name text NOT NULL DEFAULT 'Scout CLI'
    CHECK (length(client_name) BETWEEN 1 AND 80),
  agent_label text CHECK (agent_label IS NULL OR length(agent_label) BETWEEN 1 AND 80),
  device_label text CHECK (device_label IS NULL OR length(device_label) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed')),
  approved_by uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  decided_at timestamptz,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  last_polled_at timestamptz,
  poll_interval_seconds integer NOT NULL DEFAULT 5
    CHECK (poll_interval_seconds BETWEEN 1 AND 30),
  poll_count integer NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'pending' AND approved_by IS NULL AND decided_at IS NULL) OR
    (status = 'approved' AND approved_by IS NOT NULL AND decided_at IS NOT NULL) OR
    (status = 'denied' AND approved_by IS NOT NULL AND decided_at IS NOT NULL) OR
    (status = 'expired') OR
    (status = 'consumed' AND approved_by IS NOT NULL AND consumed_at IS NOT NULL)
  )
);

ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_device_authorization_fk
  FOREIGN KEY (device_authorization_id)
  REFERENCES public.cli_device_authorizations(id)
  ON DELETE SET NULL;

CREATE UNIQUE INDEX idx_api_keys_device_authorization
  ON public.api_keys(device_authorization_id)
  WHERE device_authorization_id IS NOT NULL;
CREATE INDEX idx_cli_device_authorizations_status_expiry
  ON public.cli_device_authorizations(status, expires_at);
CREATE INDEX idx_cli_device_authorizations_approved_by
  ON public.cli_device_authorizations(approved_by)
  WHERE approved_by IS NOT NULL;

CREATE TABLE public.cli_auth_rate_limits (
  bucket_hash text NOT NULL CHECK (length(bucket_hash) = 64),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 40),
  window_start timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (bucket_hash, action),
  CHECK (expires_at > window_start)
);

CREATE INDEX idx_cli_auth_rate_limits_expiry
  ON public.cli_auth_rate_limits(expires_at);

ALTER TABLE public.cli_device_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cli_auth_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.cli_device_authorizations FROM anon, authenticated;
REVOKE ALL ON public.cli_auth_rate_limits FROM anon, authenticated;

-- api_keys used to have one FOR ALL policy, which allowed direct inserts and
-- bypassed any server-side key limit. Keep owner read/delete access but funnel
-- all creation through the locked RPC below.
DROP POLICY IF EXISTS api_keys_owner_all ON public.api_keys;
DROP POLICY IF EXISTS api_keys_owner_select ON public.api_keys;
DROP POLICY IF EXISTS api_keys_owner_delete ON public.api_keys;
CREATE POLICY api_keys_owner_select ON public.api_keys
  FOR SELECT USING ((SELECT auth.uid()) = user_id);
CREATE POLICY api_keys_owner_delete ON public.api_keys
  FOR DELETE USING ((SELECT auth.uid()) = user_id);
REVOKE INSERT, UPDATE ON public.api_keys FROM anon, authenticated;

-- SECURITY DEFINER functions otherwise receive PUBLIC EXECUTE at creation.
-- Keep this restrictive default through 00103; 00104 restores the repository's
-- prior default only after explicitly revoking every CLI-auth RPC.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.consume_cli_auth_rate_limit(
  p_bucket_hash text,
  p_action text,
  p_limit integer,
  p_window_seconds integer
)
RETURNS TABLE(allowed boolean, attempts integer, retry_after integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_row public.cli_auth_rate_limits%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF length(p_bucket_hash) <> 64 OR p_limit < 1 OR
     p_window_seconds < 1 OR p_window_seconds > 86400 THEN
    RAISE EXCEPTION 'invalid rate limit arguments';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_bucket_hash || ':' || p_action, 0));

  INSERT INTO public.cli_auth_rate_limits AS limits (
    bucket_hash, action, window_start, attempts, expires_at
  )
  VALUES (
    p_bucket_hash, p_action, v_now, 1,
    v_now + make_interval(secs => p_window_seconds)
  )
  ON CONFLICT (bucket_hash, action) DO UPDATE
  SET window_start = CASE
        WHEN limits.expires_at <= v_now THEN v_now
        ELSE limits.window_start
      END,
      attempts = CASE
        WHEN limits.expires_at <= v_now THEN 1
        ELSE limits.attempts + 1
      END,
      expires_at = CASE
        WHEN limits.expires_at <= v_now
          THEN v_now + make_interval(secs => p_window_seconds)
        ELSE limits.expires_at
      END
  RETURNING * INTO v_row;

  RETURN QUERY SELECT
    v_row.attempts <= p_limit,
    v_row.attempts,
    GREATEST(1, ceil(extract(epoch FROM (v_row.expires_at - v_now)))::integer);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_api_key_atomic(
  p_user_id uuid,
  p_name text,
  p_source text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_raw text;
  v_row public.api_keys%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 100 OR
     p_source NOT IN ('manual', 'cli_device') THEN
    RAISE EXCEPTION 'invalid API key arguments';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('api-key:' || p_user_id::text, 0));
  IF (SELECT count(*) FROM public.api_keys WHERE user_id = p_user_id) >= 5 THEN
    RETURN jsonb_build_object('result', 'key_limit_reached');
  END IF;

  v_raw := 'cj_' || rtrim(translate(encode(gen_random_bytes(18), 'base64'), '+/', '-_'), '=');
  INSERT INTO public.api_keys(user_id, key_hash, key_prefix, name, source)
  VALUES (
    p_user_id, encode(digest(v_raw, 'sha256'), 'hex'), left(v_raw, 11),
    btrim(p_name), p_source
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'result', 'created',
    'api_key', v_raw,
    'key_id', v_row.id,
    'key_prefix', v_row.key_prefix,
    'key_name', v_row.name,
    'created_at', v_row.created_at
  );
END;
$$;


-- Remaining RPCs and their grants are intentionally split into one-function
-- migrations. Supabase CLI versions used by self-hosters can otherwise group
-- a long sequence of dollar-quoted functions into one prepared statement.
