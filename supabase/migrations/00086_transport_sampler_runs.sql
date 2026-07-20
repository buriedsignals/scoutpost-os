-- 00086_transport_sampler_runs.sql
-- Persist the result of asynchronous AIS/GP sampler invocations. pg_net only
-- observes the immediate 202 response; this table records what happened after
-- EdgeRuntime.waitUntil began the provider work.

CREATE TABLE IF NOT EXISTS public.transport_sampler_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task text NOT NULL CHECK (task IN ('ais', 'gp')),
  status text NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted', 'running', 'succeeded', 'failed', 'noop')),
  requested_window_ms int,
  connected boolean,
  provider_errored boolean,
  frames_received int NOT NULL DEFAULT 0 CHECK (frames_received >= 0),
  items_parsed int NOT NULL DEFAULT 0 CHECK (items_parsed >= 0),
  items_written int NOT NULL DEFAULT 0 CHECK (items_written >= 0),
  error_code text,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transport_sampler_runs_task_time
  ON public.transport_sampler_runs(task, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_transport_sampler_runs_expires
  ON public.transport_sampler_runs(expires_at);

ALTER TABLE public.transport_sampler_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.transport_sampler_runs FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.cleanup_transport_sampler_runs()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  DELETE FROM public.transport_sampler_runs
   WHERE id IN (
     SELECT id
       FROM public.transport_sampler_runs
      WHERE expires_at < now()
      LIMIT 10000
   );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_transport_sampler_runs()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_transport_sampler_runs()
  TO service_role;

DO $$
BEGIN
  PERFORM cron.unschedule('cleanup-transport-sampler-runs')
    WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'cleanup-transport-sampler-runs'
    );
  PERFORM cron.schedule(
    'cleanup-transport-sampler-runs',
    '40 3 * * *',
    'SELECT public.cleanup_transport_sampler_runs()'
  );
END;
$$;
