BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(8);

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
  'vesselapi_timeout',
  now() - interval '1 minute'
);

SELECT is(
  (
    SELECT error_code
      FROM public.transport_sampler_runs
     WHERE id = '00000000-0000-4000-8000-000000000861'
  ),
  'vesselapi_timeout',
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

SELECT has_function(
  'public',
  'trigger_transport_sampler',
  ARRAY['text'],
  'service-role transport sampler trigger exists'
);

SELECT function_privs_are(
  'public',
  'trigger_transport_sampler',
  ARRAY['text'],
  'service_role',
  ARRAY['EXECUTE'],
  'service role can request an immediate sampler canary'
);

SELECT ok(
  (
    SELECT command LIKE '%X-Service-Key%'
       AND command LIKE '%internal_service_key%'
       AND command NOT LIKE '%service_role_key%'
      FROM cron.job
     WHERE jobname = 'transport-ais-sampler'
  ),
  'hourly vessel sampler uses the internal service-key boundary'
);

SELECT ok(
  (
    SELECT command LIKE '%X-Service-Key%'
       AND command LIKE '%internal_service_key%'
       AND command NOT LIKE '%service_role_key%'
      FROM cron.job
     WHERE jobname = 'transport-gp-refresh'
  ),
  'daily GP refresh uses the internal service-key boundary'
);

SELECT * FROM finish();
ROLLBACK;
