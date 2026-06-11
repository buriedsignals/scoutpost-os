-- 00069_signup_allowlist_rls.sql
-- signup_email_allowlist (00050) was created WITHOUT row-level security. Its
-- protection rests entirely on `REVOKE ALL ... FROM anon, authenticated, public`
-- (00050) plus narrow grants to supabase_auth_admin and service_role (00051).
-- That is safe today, but an RLS-disabled public table is one accidental future
-- `GRANT SELECT ... TO authenticated` (or a blanket schema grant) away from full
-- exposure, with no backstop. Every other user-data table in the schema enables
-- RLS; this is the lone exception, and the Supabase rls_disabled_in_public
-- advisor flags it.
--
-- Enable RLS as a deny-by-default backstop. The before-user-created Auth hook,
-- public.hook_restrict_signup_by_allowlist(jsonb), is a plain (INVOKER) function
-- that the auth system runs AS supabase_auth_admin and that reads this table
-- directly (`SELECT count(*) FROM public.signup_email_allowlist`). RLS would
-- otherwise filter that read to zero rows, making the allowlist look empty and
-- fail OPEN (the rule_count = 0 branch allows every signup) — a regression. The
-- explicit supabase_auth_admin SELECT policy below is therefore load-bearing,
-- not cosmetic: it keeps the hook seeing the rules.
--
-- anon/authenticated have no policy (and the 00050 REVOKE), so they remain
-- denied. service_role bypasses RLS, so setup INSERT/UPDATE keep working.

ALTER TABLE public.signup_email_allowlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS allowlist_auth_admin_read ON public.signup_email_allowlist;
CREATE POLICY allowlist_auth_admin_read ON public.signup_email_allowlist
  FOR SELECT TO supabase_auth_admin USING (true);
