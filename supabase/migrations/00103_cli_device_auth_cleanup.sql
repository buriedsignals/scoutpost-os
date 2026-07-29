CREATE INDEX IF NOT EXISTS cli_device_authorizations_terminal_cleanup_idx
  ON public.cli_device_authorizations
  (coalesce(consumed_at, decided_at, expires_at))
  WHERE status IN ('denied', 'expired', 'consumed');

CREATE OR REPLACE FUNCTION public.cleanup_cli_device_authorizations()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.cli_device_authorizations
    SET status = 'expired'
    WHERE id IN (
      SELECT id FROM public.cli_device_authorizations
      WHERE status IN ('pending', 'approved')
        AND expires_at <= clock_timestamp()
      ORDER BY expires_at
      LIMIT 10000
      FOR UPDATE SKIP LOCKED
    );
  DELETE FROM public.cli_device_authorizations
    WHERE id IN (
      SELECT id FROM public.cli_device_authorizations
      WHERE status IN ('denied', 'expired', 'consumed')
        AND coalesce(consumed_at, decided_at, expires_at)
          < clock_timestamp() - interval '24 hours'
      ORDER BY coalesce(consumed_at, decided_at, expires_at)
      LIMIT 10000
      FOR UPDATE SKIP LOCKED
    );
  DELETE FROM public.cli_auth_rate_limits
    WHERE (bucket_hash, action) IN (
      SELECT bucket_hash, action FROM public.cli_auth_rate_limits
      WHERE expires_at <= clock_timestamp()
      ORDER BY expires_at
      LIMIT 10000
      FOR UPDATE SKIP LOCKED
    );
END;
$$;
