-- PostgreSQL's array_length('{}'::text[], 1) is NULL, and CHECK constraints
-- accept NULL. Use cardinality instead so an empty redirect URI array is
-- rejected while preserving the existing non-null column contract.

ALTER TABLE public.mcp_oauth_clients
  DROP CONSTRAINT IF EXISTS mcp_oauth_clients_redirect_uris_check;

ALTER TABLE public.mcp_oauth_clients
  ADD CONSTRAINT mcp_oauth_clients_redirect_uris_check
  CHECK (cardinality(redirect_uris) >= 1);
