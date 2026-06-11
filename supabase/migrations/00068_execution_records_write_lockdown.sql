-- 00068_execution_records_write_lockdown.sql
-- Completes the 00034 hardening pass, which locked the worker-written tables
-- (scout_runs, post_snapshots, seen_records, promises) to read-only via REVOKE
-- but missed execution_records. That table is also worker/service-written (its
-- dedup summaries + embeddings are written by the backend service role; no Edge
-- Function or user code writes it over a user JWT), yet it still carries the
-- original 00004 policy:
--
--   CREATE POLICY exec_user ON execution_records FOR ALL USING (auth.uid() = user_id);
--
-- FOR ALL with a USING clause but NO WITH CHECK lets an authenticated user
-- INSERT/UPDATE/DELETE their own rows via PostgREST (poisoning their dedup
-- corpus, or write-away on UPDATE since the post-update row is not re-checked).
-- Match the read-only posture applied to the sibling tables in 00034.
--
-- The service role bypasses RLS, so the worker write path is unaffected; the
-- row owner keeps SELECT access.

REVOKE INSERT, UPDATE, DELETE ON public.execution_records FROM anon, authenticated;

DROP POLICY IF EXISTS exec_user ON public.execution_records;
CREATE POLICY exec_user ON public.execution_records
  FOR SELECT USING ((SELECT auth.uid()) = user_id);
