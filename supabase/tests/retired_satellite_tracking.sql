BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(10);
SELECT is((SELECT count(*)::integer FROM cron.job WHERE jobname = 'transport-gp-refresh'), 0, 'GP cron removed');
SELECT hasnt_table('public', 'transport_gp_catalog', 'orbital catalog removed');
SELECT hasnt_table('public', 'transport_gp_refresh_control', 'GP provider control removed');
SELECT throws_ok($$SELECT public.trigger_transport_sampler('gp')$$, 'P0001', 'only the ais transport sampler task is supported', 'GP task rejected before network');
SELECT throws_ok($$SELECT public.trigger_transport_sampler('ais', true)$$, 'P0001', 'only the ais transport sampler task is supported', 'bootstrap rejected before network');
INSERT INTO auth.users(id) VALUES ('11111111-1111-4111-8111-111111118888');
SELECT throws_ok($$INSERT INTO public.scouts(user_id,name,type,config,is_active)
VALUES ('11111111-1111-4111-8111-111111118888','retired','transport','{"mode":"satellite","watch_ids":["25544"]}',false)$$,
'23514','satellite tracking is retired','direct inserts cannot restore satellite tracking');
SELECT is((SELECT count(*)::integer FROM public.scouts WHERE type = 'transport' AND config->>'mode' = 'satellite' AND (is_active OR schedule_cron IS NOT NULL)),0,'legacy satellite scouts cannot remain scheduled');
-- Seed a historical row as an upgrade would leave it, then exercise guards.
ALTER TABLE public.scouts DISABLE TRIGGER reject_retired_satellite_scout;
INSERT INTO public.scouts(id,user_id,name,type,config,is_active) VALUES
('22222222-2222-4222-8222-222222228888','11111111-1111-4111-8111-111111118888','historical','transport','{"mode":"satellite","watch_ids":["25544"]}',false);
ALTER TABLE public.scouts ENABLE TRIGGER reject_retired_satellite_scout;
SELECT throws_ok($$UPDATE public.scouts SET is_active=true,schedule_cron='0 8 * * *' WHERE id='22222222-2222-4222-8222-222222228888'$$,
'23514','satellite tracking is retired','historical satellite scout cannot reactivate');
SELECT throws_ok($$UPDATE public.scouts SET schedule_cron='0 8 * * *' WHERE id='22222222-2222-4222-8222-222222228888'$$,
'23514','satellite tracking is retired','historical satellite scout cannot reschedule while paused');
SELECT lives_ok($$UPDATE public.scouts SET name='historical renamed' WHERE id='22222222-2222-4222-8222-222222228888'$$,'historical metadata remains editable');
SELECT * FROM finish();
ROLLBACK;
