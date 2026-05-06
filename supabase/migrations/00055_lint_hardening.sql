-- 00055_lint_hardening.sql
-- Address Supabase advisor findings that are safe to fix without changing the
-- application contract:
--   - make helper-function search_path immutable
--   - prevent anon/authenticated callers from executing internal
--     SECURITY DEFINER RPCs directly through PostgREST
--   - add an explicit deny-all RLS policy for internal OAuth code rows
--   - remove overlapping SELECT policies on projects
--   - avoid per-row auth.uid() initplans on api_keys
--   - add covering indexes for foreign keys reported by the advisor

-- ---------------------------------------------------------------------------
-- Function search paths
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.allow_semantic_scout_match(text, text)
  SET search_path = public;
ALTER FUNCTION public.canonical_unit_type(text, text)
  SET search_path = public;
ALTER FUNCTION public.hook_restrict_signup_by_allowlist(jsonb)
  SET search_path = public;
ALTER FUNCTION public.normalize_source_url(text)
  SET search_path = public;
ALTER FUNCTION public.normalize_unit_statement(text)
  SET search_path = public;
ALTER FUNCTION public.text_array_union(text[], text[])
  SET search_path = public;
ALTER FUNCTION public.unit_type_rank(text)
  SET search_path = public;
ALTER FUNCTION public.update_signup_email_allowlist_updated_at()
  SET search_path = public;
ALTER FUNCTION public.update_updated_at()
  SET search_path = public;

-- ---------------------------------------------------------------------------
-- Internal SECURITY DEFINER RPC grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn REGPROCEDURE;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN pg_depend d
      ON d.objid = p.oid
     AND d.deptype = 'e'
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND d.objid IS NULL
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',
      fn
    );

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END IF;
  END LOOP;
END $$;

-- Supabase Auth hooks still need this function explicitly.
GRANT EXECUTE
  ON FUNCTION public.hook_restrict_signup_by_allowlist(jsonb)
  TO supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- RLS policy cleanup
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS mcp_oauth_codes_no_client_access
  ON public.mcp_oauth_codes;
CREATE POLICY mcp_oauth_codes_no_client_access
  ON public.mcp_oauth_codes
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS projects_write ON public.projects;

CREATE POLICY projects_insert
  ON public.projects
  FOR INSERT
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY projects_update
  ON public.projects
  FOR UPDATE
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY projects_delete
  ON public.projects
  FOR DELETE
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY api_keys_owner_all
  ON public.api_keys
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Covering indexes for foreign keys
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_apify_run_queue_scout_id_fk
  ON public.apify_run_queue (scout_id);
CREATE INDEX IF NOT EXISTS idx_apify_run_queue_user_id_fk
  ON public.apify_run_queue (user_id);

CREATE INDEX IF NOT EXISTS idx_civic_extraction_queue_raw_capture_id_fk
  ON public.civic_extraction_queue (raw_capture_id);
CREATE INDEX IF NOT EXISTS idx_civic_extraction_queue_scout_id_fk
  ON public.civic_extraction_queue (scout_id);
CREATE INDEX IF NOT EXISTS idx_civic_extraction_queue_user_id_fk
  ON public.civic_extraction_queue (user_id);

CREATE INDEX IF NOT EXISTS idx_execution_records_user_id_fk
  ON public.execution_records (user_id);

CREATE INDEX IF NOT EXISTS idx_information_units_deleted_by_fk
  ON public.information_units (deleted_by);
CREATE INDEX IF NOT EXISTS idx_information_units_raw_capture_id_fk
  ON public.information_units (raw_capture_id);

CREATE INDEX IF NOT EXISTS idx_ingests_project_id_fk
  ON public.ingests (project_id);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_user_id_fk
  ON public.mcp_oauth_codes (user_id);

CREATE INDEX IF NOT EXISTS idx_post_snapshots_user_id_fk
  ON public.post_snapshots (user_id);

CREATE INDEX IF NOT EXISTS idx_project_members_user_id_fk
  ON public.project_members (user_id);

CREATE INDEX IF NOT EXISTS idx_promises_unit_id_fk
  ON public.promises (unit_id);

CREATE INDEX IF NOT EXISTS idx_raw_captures_ingest_id_fk
  ON public.raw_captures (ingest_id);
CREATE INDEX IF NOT EXISTS idx_raw_captures_scout_id_fk
  ON public.raw_captures (scout_id);

CREATE INDEX IF NOT EXISTS idx_seen_records_user_id_fk
  ON public.seen_records (user_id);

CREATE INDEX IF NOT EXISTS idx_unit_occurrences_raw_capture_id_fk
  ON public.unit_occurrences (raw_capture_id);
CREATE INDEX IF NOT EXISTS idx_unit_occurrences_scout_run_id_fk
  ON public.unit_occurrences (scout_run_id);

CREATE INDEX IF NOT EXISTS idx_user_preferences_active_org_id_fk
  ON public.user_preferences (active_org_id);
