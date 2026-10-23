-- 20261023120000_mcp_oauth_sessions.sql
-- Which OAuth client a Supabase session was issued to.
--
-- /token hands the MCP client the caller's Supabase access token unchanged,
-- so a later tools/list cannot tell which client is calling. Recording the
-- token's `session_id` claim against the client at code exchange closes that
-- gap; Supabase keeps the session id across refreshes, so the link holds for
-- the life of the sign-in. mcp-server uses it to mark every tool open-world
-- for Osaurus, whose default policy runs read-only, closed-world tools
-- without asking (Osaurus `MCPProviderTool.swift`, defaultPolicy).
--
-- RLS: service_role only, like mcp_oauth_codes.
--
-- Cleanup: a row outlives its Supabase session only until the daily
-- cleanup_mcp_oauth_sessions() run. auth.sessions is not referenced by a
-- foreign key: Supabase documents references to auth.users only.

CREATE TABLE mcp_oauth_sessions (
    session_id uuid PRIMARY KEY,
    client_id uuid NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mcp_oauth_sessions_client_id_idx ON mcp_oauth_sessions(client_id);
CREATE INDEX mcp_oauth_sessions_user_id_idx ON mcp_oauth_sessions(user_id);

ALTER TABLE mcp_oauth_sessions ENABLE ROW LEVEL SECURITY;
-- No policies: anon and authenticated roles never read or write this table.

CREATE OR REPLACE FUNCTION cleanup_mcp_oauth_sessions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM mcp_oauth_sessions m
     WHERE NOT EXISTS (SELECT 1 FROM auth.sessions s WHERE s.id = m.session_id);
END;
$$;

-- Only the cron job (as the service role) runs it; never through the API.
REVOKE EXECUTE ON FUNCTION public.cleanup_mcp_oauth_sessions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_mcp_oauth_sessions() TO service_role;

SELECT cron.schedule(
    'cleanup-mcp-oauth-sessions',
    '25 3 * * *',
    'SELECT public.cleanup_mcp_oauth_sessions()'
);
