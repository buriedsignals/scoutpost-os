-- 00075_scout_preferred_language_backfill.sql
--
-- The scouts Edge Function never accepted `preferred_language` (zod silently
-- stripped it), so every scout row created since the Supabase cutover has
-- NULL — and all five workers fall back to "en", forcing English extraction
-- and notifications for every non-English user. Caught by the weekly page
-- benchmark's language check (4/4 German bullets came back English),
-- 2026-07-06.
--
-- Forward fix: the scouts EF now accepts preferred_language and defaults it
-- from user_preferences at create time. This migration repairs EXISTING rows
-- the same way: copy the owner's profile language onto their scouts where the
-- scout has none. Scouts whose owners have no stored preference stay NULL
-- (workers keep the "en" fallback).

UPDATE scouts s
SET preferred_language = p.preferred_language
FROM user_preferences p
WHERE s.user_id = p.user_id
  AND s.preferred_language IS NULL
  AND p.preferred_language IS NOT NULL
  AND p.preferred_language <> '';
