-- Page Scout renderer choice and canonical change detection no longer use
-- per-scout provider state. Refuse the destructive cleanup while any active
-- Page Scout still lacks the current successful root baseline.
BEGIN;

-- Serialize the invariant check with Page Scout creation, activation, and URL
-- changes. Fail instead of queueing behind a long-running transaction.
SET LOCAL lock_timeout = '5s';

LOCK TABLE public.scouts IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.scouts s
    WHERE s.type = 'web'
      AND s.is_active
      AND NOT EXISTS (
        SELECT 1
        FROM public.raw_captures rc
        LEFT JOIN public.scout_runs sr ON sr.id = rc.scout_run_id
        WHERE rc.scout_id = s.id
          AND rc.source_url = s.url
          AND rc.canonicalizer_version = 'web-md-v1'
          AND rc.canonical_content_sha256 IS NOT NULL
          AND (rc.scout_run_id IS NULL OR sr.status = 'success')
      )
  ) THEN
    RAISE EXCEPTION
      'cannot drop scouts.provider while an active Page Scout lacks a current canonical baseline';
  END IF;
END
$$;

-- DROP COLUMN is metadata-only, but it needs ACCESS EXCLUSIVE briefly.
ALTER TABLE public.scouts
  DROP COLUMN IF EXISTS provider;

COMMIT;
