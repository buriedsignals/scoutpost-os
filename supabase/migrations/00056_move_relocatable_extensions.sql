-- 00056_move_relocatable_extensions.sql
-- Supabase Advisor warns when extension objects live in the API-exposed
-- public schema. `vector` and `pg_trgm` are relocatable on Supabase Cloud.
--
-- `pg_net` is also installed in public on the current project, but PostgreSQL
-- rejects `ALTER EXTENSION pg_net SET SCHEMA extensions` with:
--   extension "pg_net" does not support SET SCHEMA
-- so it is intentionally left unchanged.

CREATE SCHEMA IF NOT EXISTS extensions;

ALTER EXTENSION vector SET SCHEMA extensions;
ALTER EXTENSION pg_trgm SET SCHEMA extensions;
