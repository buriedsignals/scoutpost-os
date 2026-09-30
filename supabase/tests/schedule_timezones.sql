-- Local, rollback-only database test. No persisted accounts or HTTP dispatch.
BEGIN;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

SELECT ok(public.scout_schedule_due('15 8 * * *', 'America/New_York', '2026-01-15 13:15Z'), '08:15 New York in winter');
SELECT ok(public.scout_schedule_due('15 8 * * *', 'America/New_York', '2026-07-15 12:15Z'), '08:15 New York in summer');
SELECT ok(NOT public.scout_schedule_due('15 8 * * *', 'America/New_York', '2026-07-15 13:15Z'), 'no stale winter UTC offset in summer');
SELECT ok(public.scout_schedule_due('15 8 * * *', 'Asia/Kathmandu', '2026-07-15 02:30Z'), '45-minute offset');
SELECT ok(public.scout_schedule_due('15 8 * * *', 'Asia/Kolkata', '2026-07-15 02:45Z'), '30-minute offset');
SELECT ok(public.scout_schedule_due('15 0 * * 1', 'Asia/Kathmandu', '2026-01-04 18:30Z'), 'Monday local is still Sunday UTC');
SELECT ok(public.scout_schedule_due('15 0 1 * *', 'Asia/Kathmandu', '2025-12-31 18:30Z'), 'January 1 local is still December UTC');
SELECT ok(NOT public.scout_schedule_due('15 0 31 * *', 'Asia/Kathmandu', '2026-02-28 18:30Z'), 'monthly day 31 does not shift into next month');
SELECT ok(public.scout_schedule_due('15 2,8,14,20 * * *', 'Asia/Kathmandu', '2026-07-15 14:30Z'), 'transport hour list retains local anchor');
SELECT is((SELECT count(*) FROM generate_series('2026-03-08 05:00Z'::timestamptz, '2026-03-09 03:59Z', interval '1 minute') t WHERE public.scout_schedule_due('30 2 * * *', 'America/New_York', t)), 0::bigint, 'spring gap is skipped, not shifted');
SELECT is((SELECT count(*) FROM generate_series('2026-11-01 04:00Z'::timestamptz, '2026-11-02 04:59Z', interval '1 minute') t WHERE public.scout_schedule_due('30 1 * * *', 'America/New_York', t)), 1::bigint, 'fall repeated minute is due only once');
SELECT ok(public.scout_schedule_due('30 1 * * *', 'America/New_York', '2026-11-01 06:30Z'), 'fall fold chooses standard-time occurrence');
SELECT throws_ok($$SELECT public.validate_scout_schedule('15 8 * * *', 'Mars/Olympus')$$, '22023', 'schedule_timezone must be a valid IANA timezone (or UTC)', 'invalid IANA zone is rejected');
SELECT throws_ok($$SELECT public.validate_scout_schedule('*/15 * * * *', 'America/New_York')$$, '22023', 'non-UTC schedules require fixed minute, fixed/list hours, and daily, weekly, or monthly day fields; use UTC for arbitrary cron', 'unsupported non-UTC grammar is rejected');

-- Keep a synthetic owner and its scouts in this rollback-only transaction.
-- Skip signup side effects during fixture insertion; normal writes below still
-- exercise the schedule validation trigger and foreign keys.
SET LOCAL session_replication_role = replica;
INSERT INTO auth.users (id) VALUES ('00000000-0000-4000-8000-000000009900');
INSERT INTO public.scouts (id, user_id, name, type, url, is_active, schedule_cron, schedule_timezone)
VALUES
  ('00000000-0000-4000-8000-00000000001d', '00000000-0000-4000-8000-000000009900', 'Timezone test', 'web', 'https://example.test', true, '15 8 * * *', 'America/New_York'),
  ('00000000-0000-4000-8000-00000000001e', '00000000-0000-4000-8000-000000009900', 'UTC test', 'web', 'https://example.test', true, '*/15 6-18 * * 1-5', 'UTC');
SET LOCAL session_replication_role = origin;

-- Uncommitted cron jobs are invisible to the scheduler and roll back with the
-- test. Reserved .invalid Vault values can never target a real deployment.
SELECT vault.create_secret('https://timezone-test.invalid', 'project_url')
WHERE NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url');
SELECT vault.create_secret('local-test-key', 'internal_service_key')
WHERE NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key');
SELECT public.schedule_scout('00000000-0000-4000-8000-00000000001d', '15 8 * * *');
SELECT public.schedule_scout('00000000-0000-4000-8000-00000000001e', '*/15 6-18 * * 1-5');
SELECT is((SELECT schedule FROM cron.job WHERE jobname = 'scout-00000000-0000-4000-8000-00000000001d'), '* * * * *', 'non-UTC job ticks every minute');
SELECT is((SELECT schedule FROM cron.job WHERE jobname = 'scout-00000000-0000-4000-8000-00000000001e'), '*/15 6-18 * * 1-5', 'arbitrary UTC cron stays native and unchanged');
SELECT ok(public.claim_scout_schedule('00000000-0000-4000-8000-00000000001d', '2026-07-15 12:15Z'), 'due scout claims its local slot');
SELECT ok(NOT public.claim_scout_schedule('00000000-0000-4000-8000-00000000001d', '2026-07-15 12:15:30Z'), 'same minute cannot claim twice');
UPDATE public.scouts SET is_active = false WHERE id = '00000000-0000-4000-8000-00000000001d';
SELECT public.unschedule_scout('00000000-0000-4000-8000-00000000001d');
SELECT ok(NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'scout-00000000-0000-4000-8000-00000000001d'), 'pause removes the minute tick');
SELECT ok(NOT public.claim_scout_schedule('00000000-0000-4000-8000-00000000001d', '2026-07-16 12:15Z'), 'paused scout does not claim');
UPDATE public.scouts SET is_active = true WHERE id = '00000000-0000-4000-8000-00000000001d';
SELECT public.schedule_scout('00000000-0000-4000-8000-00000000001d', '15 8 * * *');
SELECT ok(public.claim_scout_schedule('00000000-0000-4000-8000-00000000001d', '2026-07-16 12:15Z'), 'resumed scout retains local schedule');
UPDATE public.scouts SET schedule_timezone = 'Asia/Kathmandu' WHERE id = '00000000-0000-4000-8000-00000000001d';
SELECT public.schedule_scout('00000000-0000-4000-8000-00000000001d', '15 8 * * *');
SELECT ok(public.claim_scout_schedule('00000000-0000-4000-8000-00000000001d', '2026-07-17 02:30Z'), 'timezone-only update takes effect without wedging the claim');
SELECT is((SELECT schedule_timezone FROM public.scouts WHERE id = '00000000-0000-4000-8000-00000000001d'), 'Asia/Kathmandu', 'stored row preserves timezone');
SELECT throws_ok($$UPDATE public.scouts SET schedule_timezone = 'invalid/zone' WHERE id = '00000000-0000-4000-8000-00000000001d'$$, '22023', 'schedule_timezone must be a valid IANA timezone (or UTC)', 'invalid update is rejected before mutation');
SELECT is((SELECT schedule_timezone FROM public.scouts WHERE id = '00000000-0000-4000-8000-00000000001d'), 'Asia/Kathmandu', 'invalid update keeps prior timezone');

UPDATE public.scouts SET schedule_cron = '0 8 * * *' WHERE id = '00000000-0000-4000-8000-00000000001d';
SELECT public.schedule_scout('00000000-0000-4000-8000-00000000001d', '0 8 * * *');
SELECT ok(NOT public.claim_scout_schedule('00000000-0000-4000-8000-00000000001d', '2026-07-18 02:15Z'), 'top-of-hour timezone job honors spreading');
SELECT ok(public.claim_scout_schedule('00000000-0000-4000-8000-00000000001d', '2026-07-18 02:44Z'), 'spread remains 29 local minutes for UUID byte 29');
UPDATE public.scouts SET metadata = metadata || '{"exact_schedule":true}', schedule_timezone = 'America/New_York', schedule_cron = '30 1 * * *' WHERE id = '00000000-0000-4000-8000-00000000001d';
SELECT ok(NOT public.claim_scout_schedule('00000000-0000-4000-8000-00000000001d', '2026-11-01 05:30Z'), 'first fold occurrence does not claim');
SAVEPOINT dispatch_attempt;
DO $$ BEGIN PERFORM public.claim_scout_schedule('00000000-0000-4000-8000-00000000001d', '2026-11-01 06:30Z'); END $$;
ROLLBACK TO SAVEPOINT dispatch_attempt;
SELECT ok(public.claim_scout_schedule('00000000-0000-4000-8000-00000000001d', '2026-11-01 06:30Z'), 'rolled-back dispatch does not consume claim');
UPDATE public.scouts SET is_active = false WHERE id = '00000000-0000-4000-8000-00000000001d';
UPDATE public.scouts SET is_active = true WHERE id = '00000000-0000-4000-8000-00000000001d';
SELECT ok(NOT public.claim_scout_schedule('00000000-0000-4000-8000-00000000001d', '2026-11-01 06:30Z'), 'pause/resume cannot repeat a claimed fold slot');
SELECT ok(public.claim_scout_schedule('00000000-0000-4000-8000-00000000001d', '2026-11-02 06:30Z'), 'next day is not wedged by fold claim');
SELECT * FROM finish();
ROLLBACK;
