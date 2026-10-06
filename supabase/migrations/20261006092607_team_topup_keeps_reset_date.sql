-- Team pool top-ups keep the reset date when the provider omits it, and
-- return the final balance as documented.
--
-- 00025 set update_on = p_update_on unconditionally. applyTeamOrgTopup passes
-- NULL when the MuckRock entitlement has no update_on, which cleared the date;
-- reset_expired_credits (update_on <= CURRENT_DATE) then never refilled that
-- pool. The second UPDATE ... RETURNING INTO also overwrote the result with
-- NULL whenever no downgrade clip happened. One UPDATE now applies the upgrade
-- delta and the downgrade clip together.
CREATE OR REPLACE FUNCTION public.topup_team_credits(
    p_org_id UUID,
    p_new_cap INT,
    p_update_on DATE
)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_balance INT;
BEGIN
    UPDATE credit_accounts
       SET balance = LEAST(
             balance + GREATEST(0, p_new_cap - monthly_cap),
             p_new_cap
           ),
           monthly_cap = p_new_cap,
           update_on = COALESCE(p_update_on, update_on),
           updated_at = NOW()
     WHERE org_id = p_org_id
     RETURNING credit_accounts.balance INTO v_balance;

    RETURN v_balance;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.topup_team_credits(UUID, INT, DATE)
  FROM PUBLIC, anon, authenticated;

-- Unscheduled since 00059; reconcile_stale_scout_runs is the live cron and
-- nothing (code, cron, tests) calls this any more.
DROP FUNCTION IF EXISTS public.cleanup_stale_scout_runs(interval);
