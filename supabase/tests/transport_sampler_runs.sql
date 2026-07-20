BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(4);

SELECT has_table(
  'public',
  'transport_sampler_runs',
  'transport sampler heartbeat table exists'
);

INSERT INTO public.transport_sampler_runs (
  id, task, status, connected, provider_errored, frames_received,
  items_parsed, items_written, error_code, expires_at
) VALUES (
  '00000000-0000-4000-8000-000000000861',
  'ais',
  'failed',
  false,
  true,
  0,
  0,
  0,
  'ais_not_connected',
  now() - interval '1 minute'
);

SELECT is(
  (
    SELECT error_code
      FROM public.transport_sampler_runs
     WHERE id = '00000000-0000-4000-8000-000000000861'
  ),
  'ais_not_connected',
  'heartbeat stores a machine-readable provider failure'
);

SELECT is(
  public.cleanup_transport_sampler_runs(),
  1,
  'cleanup removes expired sampler runs'
);

SELECT is(
  (
    SELECT count(*)::int
      FROM public.transport_sampler_runs
     WHERE id = '00000000-0000-4000-8000-000000000861'
  ),
  0,
  'expired heartbeat was removed'
);

SELECT * FROM finish();
ROLLBACK;
