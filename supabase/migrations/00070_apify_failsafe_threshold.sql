-- 00070_apify_failsafe_threshold.sql
-- Align the SQL last-resort timeout with apify-reconcile so the refunding path
-- wins. apify_mark_timeouts (00022) marked rows 'timeout' at 2h but does NOT
-- refund the pre-charge or update scout_runs. apify-reconcile (every 10 min)
-- only processes rows still in status='running' and escalates a genuinely-stuck
-- run to 'timeout' WITH a refund at 4h. A row stuck at 2-4h was therefore
-- marked terminal by the SQL failsafe first, dropping it out of reconcile's
-- 'running' filter, so its credits were never refunded.
--
-- Raise the SQL failsafe to 6h: comfortably past reconcile's 4h refund
-- escalation (with margin for reconcile's 10-min cadence), so reconcile settles
-- and refunds stuck runs first. The SQL failsafe stays a true last resort for
-- when reconcile cannot run (e.g. no vault secrets in local dev), unsticking
-- orphans even though it cannot refund.

CREATE OR REPLACE FUNCTION apify_mark_timeouts()
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE apify_run_queue
  SET status = 'timeout',
      last_error = 'no callback within 6h',
      completed_at = NOW()
  WHERE status IN ('pending', 'running')
    AND started_at IS NOT NULL
    AND started_at < NOW() - INTERVAL '6 hours';
$$;
