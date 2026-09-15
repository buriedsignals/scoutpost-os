-- Page-only validation metadata. Legacy captures are classified lazily from
-- their actual body by the shared Page reader, never bulk-labelled successful.
ALTER TABLE public.raw_captures
  ADD COLUMN page_response_status integer,
  ADD COLUMN page_validation_version text,
  ADD COLUMN page_validation_outcome text;

ALTER TABLE public.raw_captures ADD CONSTRAINT raw_captures_page_validation
  CHECK (
    (page_validation_version IS NULL AND page_validation_outcome IS NULL)
    OR (
      page_validation_version IS NOT NULL
      AND page_validation_outcome IS NOT NULL
      AND page_validation_outcome IN (
        'valid', 'target_http_error', 'empty_content', 'error_page',
        'outside_configured_page'
      )
    )
  );

-- Keep the latest validated baseline and every still-unvalidated candidate.
-- Otherwise a historical error page can shadow an earlier valid capture and
-- TTL cleanup can erase that earlier evidence before the reader classifies it.
-- Confirmed invalid captures retain ordinary evidence TTL; classification
-- itself neither deletes content nor promotes a failed run.
CREATE OR REPLACE FUNCTION public.cleanup_scout_runs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('cleanup_scout_runs')) THEN
    RETURN;
  END IF;

  WITH expiring_runs AS (
    SELECT id FROM scout_runs
     WHERE expires_at < NOW()
     ORDER BY expires_at
     LIMIT 10000
  ),
  retained_page_baselines AS (
    SELECT DISTINCT ON (
      capture.scout_id, capture.source_url,
      CASE WHEN capture.page_validation_version IS DISTINCT FROM 'page-response-v1'
        THEN capture.id END
    ) capture.id
      FROM raw_captures AS capture
      JOIN scouts AS scout ON scout.id = capture.scout_id
      LEFT JOIN scout_runs AS run ON run.id = capture.scout_run_id
     WHERE scout.type = 'web'
       AND capture.canonical_content_sha256 IS NOT NULL
       AND (capture.scout_run_id IS NULL OR run.status = 'success')
       AND (capture.page_validation_version IS DISTINCT FROM 'page-response-v1'
            OR capture.page_validation_outcome = 'valid')
       AND (
         capture.source_url = scout.url
         OR jsonb_typeof(scout.metadata->'page_scout_active_candidates')
              IS DISTINCT FROM 'array'
         OR capture.source_url IN (
           SELECT jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(scout.metadata->'page_scout_active_candidates') = 'array'
               THEN scout.metadata->'page_scout_active_candidates'
               ELSE '[]'::jsonb END
           )
         )
       )
     ORDER BY capture.scout_id, capture.source_url,
       CASE WHEN capture.page_validation_version IS DISTINCT FROM 'page-response-v1'
         THEN capture.id END,
       capture.captured_at DESC, capture.id DESC
  )
  UPDATE raw_captures SET scout_run_id = NULL
   WHERE id IN (SELECT id FROM retained_page_baselines)
     AND scout_run_id IN (SELECT id FROM expiring_runs);

  DELETE FROM scout_runs WHERE id IN (
    SELECT id FROM scout_runs
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
  WITH retained_page_baselines AS (
    SELECT DISTINCT ON (
      capture.scout_id, capture.source_url,
      CASE WHEN capture.page_validation_version IS DISTINCT FROM 'page-response-v1'
        THEN capture.id END
    ) capture.id
      FROM raw_captures AS capture
      JOIN scouts AS scout ON scout.id = capture.scout_id
      LEFT JOIN scout_runs AS run ON run.id = capture.scout_run_id
     WHERE scout.type = 'web'
       AND capture.canonical_content_sha256 IS NOT NULL
       AND (capture.scout_run_id IS NULL OR run.status = 'success')
       AND (capture.page_validation_version IS DISTINCT FROM 'page-response-v1'
            OR capture.page_validation_outcome = 'valid')
       AND (
         capture.source_url = scout.url
         OR jsonb_typeof(scout.metadata->'page_scout_active_candidates')
              IS DISTINCT FROM 'array'
         OR capture.source_url IN (
           SELECT jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(scout.metadata->'page_scout_active_candidates') = 'array'
               THEN scout.metadata->'page_scout_active_candidates'
               ELSE '[]'::jsonb END
           )
         )
       )
     ORDER BY capture.scout_id, capture.source_url,
       CASE WHEN capture.page_validation_version IS DISTINCT FROM 'page-response-v1'
         THEN capture.id END,
       capture.captured_at DESC, capture.id DESC
  )
  DELETE FROM raw_captures WHERE id IN (
    SELECT capture.id FROM raw_captures AS capture
     WHERE capture.expires_at IS NOT NULL
       AND capture.expires_at < NOW()
       AND NOT EXISTS (
         SELECT 1 FROM retained_page_baselines AS pinned
          WHERE pinned.id = capture.id
       )
     ORDER BY capture.expires_at
     LIMIT 10000
  );
END;
$$;
