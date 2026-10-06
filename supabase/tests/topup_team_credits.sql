BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(12);

SELECT has_function(
  'public', 'topup_team_credits',
  ARRAY['uuid', 'integer', 'date'],
  'team pool top-up RPC exists'
);
SELECT is(
  has_function_privilege(
    'anon', 'public.topup_team_credits(uuid,int,date)', 'EXECUTE'
  ),
  false,
  'anon cannot top up team pools'
);
SELECT is(
  has_function_privilege(
    'authenticated', 'public.topup_team_credits(uuid,int,date)', 'EXECUTE'
  ),
  false,
  'browser sessions cannot top up team pools'
);
SELECT is(
  has_function_privilege(
    'service_role', 'public.topup_team_credits(uuid,int,date)', 'EXECUTE'
  ),
  true,
  'the billing webhook tops up through the service role'
);

INSERT INTO public.orgs (id, name) VALUES
  ('00000000-0000-0000-0000-000000003001', 'Topup Tribune'),
  ('00000000-0000-0000-0000-000000003002', 'Bystander Gazette');
INSERT INTO public.credit_accounts (
  org_id, tier, monthly_cap, balance, update_on
) VALUES
  ('00000000-0000-0000-0000-000000003001', 'team', 5000, 2000, DATE '2026-11-01'),
  ('00000000-0000-0000-0000-000000003002', 'team', 5000, 1234, DATE '2026-11-01');

-- Seat or plan upgrade: the remaining balance gains only the cap difference.
SELECT public.topup_team_credits(
  '00000000-0000-0000-0000-000000003001', 8000, DATE '2026-12-01'
);
SELECT is(
  (SELECT balance FROM public.credit_accounts
   WHERE org_id = '00000000-0000-0000-0000-000000003001'),
  5000,
  'an upgrade adds the cap difference to the remaining balance'
);
SELECT is(
  (SELECT monthly_cap FROM public.credit_accounts
   WHERE org_id = '00000000-0000-0000-0000-000000003001'),
  8000,
  'an upgrade raises the pool cap'
);
SELECT is(
  (SELECT update_on FROM public.credit_accounts
   WHERE org_id = '00000000-0000-0000-0000-000000003001'),
  DATE '2026-12-01',
  'the provider billing date becomes the next reset date'
);

-- A webhook retry delivers the same cap again.
SELECT public.topup_team_credits(
  '00000000-0000-0000-0000-000000003001', 8000, DATE '2026-12-01'
);
SELECT is(
  (SELECT balance FROM public.credit_accounts
   WHERE org_id = '00000000-0000-0000-0000-000000003001'),
  5000,
  'a retried top-up at the same cap does not add credits again'
);

-- Downgrade below the remaining balance.
SELECT public.topup_team_credits(
  '00000000-0000-0000-0000-000000003001', 3000, DATE '2026-12-01'
);
SELECT is(
  (SELECT balance FROM public.credit_accounts
   WHERE org_id = '00000000-0000-0000-0000-000000003001'),
  3000,
  'a downgrade clips the remaining balance to the new cap'
);
SELECT is(
  (SELECT monthly_cap FROM public.credit_accounts
   WHERE org_id = '00000000-0000-0000-0000-000000003001'),
  3000,
  'a downgrade lowers the pool cap'
);

-- Downgrade above the remaining balance: spent credits stay spent.
UPDATE public.credit_accounts
   SET balance = 1000
 WHERE org_id = '00000000-0000-0000-0000-000000003001';
SELECT public.topup_team_credits(
  '00000000-0000-0000-0000-000000003001', 2000, DATE '2026-12-01'
);
SELECT is(
  (SELECT balance FROM public.credit_accounts
   WHERE org_id = '00000000-0000-0000-0000-000000003001'),
  1000,
  'a downgrade above the remaining balance leaves it unchanged'
);

SELECT results_eq(
  $$SELECT balance, monthly_cap, update_on FROM public.credit_accounts
    WHERE org_id = '00000000-0000-0000-0000-000000003002'$$,
  $$VALUES (1234, 5000, DATE '2026-11-01')$$,
  'other team pools are untouched'
);

SELECT * FROM finish();
ROLLBACK;
