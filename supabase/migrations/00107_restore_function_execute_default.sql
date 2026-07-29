-- Preserve the repository's pre-existing default for unrelated future
-- migrations. The CLI-auth functions retain the explicit restrictions applied
-- in 00104.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
