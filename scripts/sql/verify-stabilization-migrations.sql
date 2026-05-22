\set ON_ERROR_STOP on

-- Read-only verification for the Scoutpost stabilization migrations 00061-00064.
-- Usage:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/verify-stabilization-migrations.sql

DO $$
DECLARE
  failures text[];
BEGIN
  WITH expected(table_name, column_name, required_not_null, required_default_like) AS (
    VALUES
      ('scouts', 'metadata', true, '%''{}''::jsonb%'),
      ('scout_runs', 'metadata', true, '%''{}''::jsonb%'),
      ('scout_runs', 'sources_scraped', true, '0'),
      ('scout_runs', 'sources_failed', true, '0'),
      ('information_units', 'discovered_from_url', false, NULL),
      ('unit_occurrences', 'discovered_from_url', false, NULL),
      ('beat_ab_runs', 'retrieval', true, NULL),
      ('beat_ab_runs', 'metadata', true, '%''{}''::jsonb%'),
      ('beat_ab_runs', 'total_cost_dollars', false, NULL)
  ),
  actual AS (
    SELECT table_name, column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
  ),
  bad AS (
    SELECT format('missing column public.%I.%I', e.table_name, e.column_name) AS failure
    FROM expected e
    LEFT JOIN actual a USING (table_name, column_name)
    WHERE a.column_name IS NULL

    UNION ALL

    SELECT format('column public.%I.%I should be NOT NULL', e.table_name, e.column_name)
    FROM expected e
    JOIN actual a USING (table_name, column_name)
    WHERE e.required_not_null AND a.is_nullable <> 'NO'

    UNION ALL

    SELECT format(
      'column public.%I.%I should have default matching %s, got %s',
      e.table_name,
      e.column_name,
      e.required_default_like,
      COALESCE(a.column_default, '<NULL>')
    )
    FROM expected e
    JOIN actual a USING (table_name, column_name)
    WHERE e.required_default_like IS NOT NULL
      AND COALESCE(a.column_default, '') NOT LIKE e.required_default_like
  )
  SELECT array_agg(failure ORDER BY failure) INTO failures
  FROM bad;

  IF failures IS NOT NULL THEN
    RAISE EXCEPTION 'stabilization column verification failed: %', array_to_string(failures, '; ');
  END IF;

  WITH expected(indexname) AS (
    VALUES
      ('idx_scout_runs_source_failures'),
      ('idx_information_units_discovered_from_url'),
      ('idx_unit_occurrences_discovered_from_url'),
      ('idx_scouts_social_adapter_status'),
      ('idx_scout_runs_social_adapter_status'),
      ('idx_beat_ab_runs_scout_time'),
      ('idx_beat_ab_runs_retrieval_time'),
      ('idx_beat_ab_runs_run')
  ),
  bad AS (
    SELECT format('missing index public.%I', e.indexname) AS failure
    FROM expected e
    LEFT JOIN pg_indexes i
      ON i.schemaname = 'public'
     AND i.indexname = e.indexname
    WHERE i.indexname IS NULL
  )
  SELECT array_agg(failure ORDER BY failure) INTO failures
  FROM bad;

  IF failures IS NOT NULL THEN
    RAISE EXCEPTION 'stabilization index verification failed: %', array_to_string(failures, '; ');
  END IF;

  SELECT array_agg(failure ORDER BY failure) INTO failures
  FROM (
    SELECT 'missing table public.beat_ab_runs' AS failure
    WHERE to_regclass('public.beat_ab_runs') IS NULL

    UNION ALL

    SELECT 'public.beat_ab_runs should have row level security enabled'
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'beat_ab_runs'
      AND NOT c.relrowsecurity

    UNION ALL

    SELECT 'missing policy public.beat_ab_runs.beat_ab_runs_user_read'
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_policy
      WHERE polrelid = to_regclass('public.beat_ab_runs')
        AND polname = 'beat_ab_runs_user_read'
    )
  ) checks;

  IF failures IS NOT NULL THEN
    RAISE EXCEPTION 'stabilization RLS/policy verification failed: %', array_to_string(failures, '; ');
  END IF;
END
$$;

SELECT 'stabilization migrations verified' AS result;

SELECT table_name, column_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'scout_runs' AND column_name IN ('sources_scraped', 'sources_failed', 'metadata'))
    OR (table_name = 'scouts' AND column_name = 'metadata')
    OR (table_name IN ('information_units', 'unit_occurrences') AND column_name = 'discovered_from_url')
    OR (table_name = 'beat_ab_runs' AND column_name IN ('retrieval', 'metadata', 'total_cost_dollars'))
  )
ORDER BY table_name, column_name;

SELECT tablename, indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'idx_scout_runs_source_failures',
    'idx_information_units_discovered_from_url',
    'idx_unit_occurrences_discovered_from_url',
    'idx_scouts_social_adapter_status',
    'idx_scout_runs_social_adapter_status',
    'idx_beat_ab_runs_scout_time',
    'idx_beat_ab_runs_retrieval_time',
    'idx_beat_ab_runs_run'
  )
ORDER BY indexname;

SELECT c.relrowsecurity AS beat_ab_runs_rls_enabled, p.polname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public'
  AND c.relname = 'beat_ab_runs'
ORDER BY p.polname;
