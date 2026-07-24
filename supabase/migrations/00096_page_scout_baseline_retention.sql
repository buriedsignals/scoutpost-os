-- Keep Page Scout comparison state for the lifetime of the scout.
--
-- Run diagnostics remain disposable. The first successful index membership is
-- therefore pinned on scouts.metadata, while the newest successful canonical
-- capture per Page Scout URL is detached before its run expires and excluded
-- from raw-capture TTL cleanup.

CREATE OR REPLACE FUNCTION public.set_page_scout_initial_candidates_if_absent(
  p_scout_id UUID,
  p_candidates JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  IF jsonb_typeof(p_candidates) <> 'array'
     OR jsonb_array_length(p_candidates) > 500
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(p_candidates) AS candidate(value)
       WHERE jsonb_typeof(candidate.value) <> 'string'
     )
  THEN
    RAISE EXCEPTION 'page scout initial candidates must be an array of at most 500 strings';
  END IF;

  UPDATE public.scouts
     SET metadata = COALESCE(metadata, '{}'::jsonb)
       || jsonb_build_object('page_scout_initial_candidates', p_candidates),
         updated_at = NOW()
   WHERE id = p_scout_id
     AND type = 'web'
     AND NOT (
       COALESCE(metadata, '{}'::jsonb)
       ? 'page_scout_initial_candidates'
     );
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.set_page_scout_initial_candidates_if_absent(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_page_scout_initial_candidates_if_absent(UUID, JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.set_page_scout_active_candidates(
  p_scout_id UUID,
  p_candidates JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  IF jsonb_typeof(p_candidates) <> 'array'
     OR jsonb_array_length(p_candidates) > 500
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(p_candidates) AS candidate(value)
       WHERE jsonb_typeof(candidate.value) <> 'string'
     )
  THEN
    RAISE EXCEPTION 'page scout active candidates must be an array of at most 500 strings';
  END IF;

  UPDATE public.scouts
     SET metadata = COALESCE(metadata, '{}'::jsonb)
       || jsonb_build_object('page_scout_active_candidates', p_candidates),
         updated_at = NOW()
   WHERE id = p_scout_id
     AND type = 'web';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.set_page_scout_active_candidates(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_page_scout_active_candidates(UUID, JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.cleanup_scout_runs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- The function uses the same ordered 10k batch in the detach and delete
  -- statements below. Serialize invocations so an overlapping cron/operator
  -- call cannot advance the second statement to a different, undetached batch.
  IF NOT pg_try_advisory_xact_lock(hashtext('cleanup_scout_runs')) THEN
    RETURN;
  END IF;

  -- A successful canonical capture is comparison state, not disposable run
  -- telemetry. Detach only the newest capture for each Page Scout source whose
  -- owning run is about to expire; scout deletion still cascades via scout_id.
  WITH expiring_runs AS (
    SELECT id
      FROM scout_runs
     WHERE expires_at < NOW()
     ORDER BY expires_at
     LIMIT 10000
  ),
  newest_successful AS (
    SELECT DISTINCT ON (capture.scout_id, capture.source_url)
           capture.id
      FROM raw_captures AS capture
      JOIN scouts AS scout ON scout.id = capture.scout_id
      LEFT JOIN scout_runs AS run ON run.id = capture.scout_run_id
     WHERE scout.type = 'web'
       AND capture.canonical_content_sha256 IS NOT NULL
       AND (capture.scout_run_id IS NULL OR run.status = 'success')
       AND (
         capture.source_url = scout.url
         OR jsonb_typeof(
           scout.metadata->'page_scout_active_candidates'
         ) IS DISTINCT FROM 'array'
         OR capture.source_url IN (
           SELECT jsonb_array_elements_text(
             CASE
               WHEN jsonb_typeof(
                 scout.metadata->'page_scout_active_candidates'
               ) = 'array'
               THEN scout.metadata->'page_scout_active_candidates'
               ELSE '[]'::jsonb
             END
           )
         )
       )
     ORDER BY capture.scout_id, capture.source_url, capture.captured_at DESC,
              capture.id DESC
  )
  UPDATE raw_captures
     SET scout_run_id = NULL
   WHERE id IN (SELECT id FROM newest_successful)
     AND scout_run_id IN (SELECT id FROM expiring_runs);

  DELETE FROM scout_runs
   WHERE id IN (
     SELECT id
       FROM scout_runs
      WHERE expires_at < NOW()
      ORDER BY expires_at
      LIMIT 10000
   );
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_raw_captures()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  WITH newest_page_baselines AS (
    SELECT DISTINCT ON (capture.scout_id, capture.source_url)
           capture.id
      FROM raw_captures AS capture
      JOIN scouts AS scout ON scout.id = capture.scout_id
      LEFT JOIN scout_runs AS run ON run.id = capture.scout_run_id
     WHERE scout.type = 'web'
       AND capture.canonical_content_sha256 IS NOT NULL
       AND (capture.scout_run_id IS NULL OR run.status = 'success')
       AND (
         capture.source_url = scout.url
         OR jsonb_typeof(
           scout.metadata->'page_scout_active_candidates'
         ) IS DISTINCT FROM 'array'
         OR capture.source_url IN (
           SELECT jsonb_array_elements_text(
             CASE
               WHEN jsonb_typeof(
                 scout.metadata->'page_scout_active_candidates'
               ) = 'array'
               THEN scout.metadata->'page_scout_active_candidates'
               ELSE '[]'::jsonb
             END
           )
         )
       )
     ORDER BY capture.scout_id, capture.source_url, capture.captured_at DESC,
              capture.id DESC
  )
  DELETE FROM raw_captures
   WHERE id IN (
     SELECT capture.id
       FROM raw_captures AS capture
      WHERE capture.expires_at IS NOT NULL
        AND capture.expires_at < NOW()
        AND NOT EXISTS (
          SELECT 1
            FROM newest_page_baselines AS pinned
           WHERE pinned.id = capture.id
        )
      ORDER BY capture.expires_at
      LIMIT 10000
   );
END;
$$;
