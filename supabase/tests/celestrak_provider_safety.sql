BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(17);

SELECT has_table(
  'public',
  'transport_gp_refresh_control',
  'CelesTrak refresh control exists'
);
SELECT has_table(
  'public',
  'transport_gp_catalog',
  'versioned GP catalog exists'
);
SELECT lives_ok(
  $$SELECT * FROM public.record_operator_incident(
    'celestrak_gp_provider_health',
    'celestrak_gp_provider_health',
    true,
    'critical',
    'CelesTrak GP provider access halted',
    '{}'::jsonb,
    300
  )$$,
  'operator incident schema accepts CelesTrak provider alerts'
);
SELECT is(
  (SELECT enabled FROM public.transport_gp_refresh_control WHERE singleton),
  false,
  'provider access is disabled by default'
);
SELECT is(
  (SELECT reason FROM public.acquire_transport_gp_refresh_lease(
    '00000000-0000-4000-8000-000000000001', 120
  )),
  'disabled',
  'disabled provider never grants a lease'
);
SELECT throws_ok(
  $$SELECT public.set_transport_gp_refresh_enabled(true, NULL, false)$$,
  'P0001',
  'approved_by is required to enable CelesTrak refresh',
  'provider enablement requires recorded approval'
);
SELECT is(
  (public.set_transport_gp_refresh_enabled(true, 'operator@example.com', false)).enabled,
  true,
  'operator can record approval and enable provider access'
);
SELECT is(
  (SELECT acquired FROM public.acquire_transport_gp_refresh_lease(
    '00000000-0000-4000-8000-000000000002', 120
  )),
  true,
  'first caller acquires the singleton lease'
);
SELECT is(
  (SELECT reason FROM public.acquire_transport_gp_refresh_lease(
    '00000000-0000-4000-8000-000000000003', 120
  )),
  'busy',
  'overlapping caller is coalesced'
);
SELECT is(
  public.halt_transport_gp_refresh(
    '00000000-0000-4000-8000-000000000002',
    'celestrak_http_503',
    503,
    'Service unavailable'
  ),
  true,
  'provider error durably halts the lease owner'
);
SELECT is(
  (SELECT reason FROM public.acquire_transport_gp_refresh_lease(
    '00000000-0000-4000-8000-000000000004', 120
  )),
  'halted',
  'halted provider rejects later callers'
);
SELECT is(
  (public.set_transport_gp_refresh_enabled(
    true, 'operator@example.com', true
  )).halted_at,
  NULL::timestamptz,
  'explicit operator action clears the halt'
);
SELECT is(
  (SELECT acquired FROM public.acquire_transport_gp_refresh_lease(
    '00000000-0000-4000-8000-000000000005', 120
  )),
  true,
  'refresh can resume only after operator clearance'
);

INSERT INTO public.transport_gp_catalog (
  generation_id, norad_id, name, omm, fetched_at
) VALUES
  ('00000000-0000-4000-8000-000000000010', 25544, 'ISS', '{}'::jsonb, now()),
  ('00000000-0000-4000-8000-000000000010', 39084, 'LANDSAT 8', '{}'::jsonb, now());

SELECT is(
  public.complete_transport_gp_refresh(
    '00000000-0000-4000-8000-000000000005',
    '00000000-0000-4000-8000-000000000010',
    now(),
    200
  ),
  2,
  'complete publishes one non-empty generation atomically'
);
SELECT is(
  (SELECT current_generation_id FROM public.transport_gp_refresh_control WHERE singleton),
  '00000000-0000-4000-8000-000000000010'::uuid,
  'control points readers at the completed generation'
);
SELECT function_privs_are(
  'public',
  'acquire_transport_gp_refresh_lease',
  ARRAY['uuid', 'integer'],
  'service_role',
  ARRAY['EXECUTE'],
  'only service role can acquire a refresh lease'
);
SELECT ok(
  (
    SELECT command LIKE '%transport_gp_refresh_control%'
       AND command LIKE '%halted_at IS NULL%'
      FROM cron.job
     WHERE jobname = 'transport-gp-refresh'
  ),
  'daily cron is gated before pg_net by enabled and halt state'
);

SELECT * FROM finish();
ROLLBACK;
