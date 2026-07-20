BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(6);

SELECT is(
  public.effective_scout_cron(
    '00000000-0000-0000-0000-000000000001'::uuid,
    '0 8 * * *'
  ),
  '1 8 * * *',
  'top-of-hour schedule receives deterministic UUID offset'
);

SELECT is(
  public.effective_scout_cron(
    '00000000-0000-0000-0000-00000000000e'::uuid,
    '0 8 * * 1'
  ),
  '14 8 * * 1',
  'spread preserves day fields'
);

SELECT is(
  public.effective_scout_cron(
    '00000000-0000-0000-0000-000000000001'::uuid,
    '15 8 * * *'
  ),
  '15 8 * * *',
  'non-zero requested minutes retain exact semantics'
);

SELECT is(
  public.effective_scout_cron(
    '00000000-0000-0000-0000-000000000001'::uuid,
    '0 */6 * * *'
  ),
  '0 */6 * * *',
  'complex hour expressions are not rewritten'
);

SELECT is(
  public.effective_scout_cron(
    '00000000-0000-0000-0000-000000000001'::uuid,
    '0 8 * * *',
    true
  ),
  '0 8 * * *',
  'exact-time opt-out retains the requested expression'
);

SELECT is(
  public.effective_scout_cron(
    '00000000-0000-0000-0000-000000000001'::uuid,
    '0 8 * * *'
  ),
  public.effective_scout_cron(
    '00000000-0000-0000-0000-000000000001'::uuid,
    '0 8 * * *'
  ),
  'spread is stable across calls'
);

SELECT * FROM finish();
ROLLBACK;
