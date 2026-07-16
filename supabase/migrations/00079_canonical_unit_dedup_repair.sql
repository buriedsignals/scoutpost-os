-- Repair canonical-unit identity after 00046 introduced a second overload and
-- allowed source identity (URL/content hash) to select a proposition.
--
-- A source can contain many propositions. URL and content hashes therefore
-- remain occurrence provenance, while normalized statement_hash is the only
-- exact canonical identity.

DROP FUNCTION IF EXISTS public.upsert_canonical_unit(
  UUID, TEXT, TEXT, TEXT[], extensions.vector, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, DATE, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT, UUID, UUID, UUID,
  JSONB, REAL, REAL, INT
);

DROP FUNCTION IF EXISTS public.upsert_canonical_unit(
  UUID, TEXT, TEXT, TEXT[], extensions.vector, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, DATE, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT, UUID, UUID, UUID,
  JSONB, REAL, REAL, INT, BOOLEAN, REAL, BOOLEAN, TEXT
);

CREATE OR REPLACE FUNCTION public.allow_semantic_scout_match(
  existing_scout_type TEXT,
  incoming_scout_type TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NOT (
    (existing_scout_type = 'social' AND incoming_scout_type IS DISTINCT FROM 'social')
    OR
    (incoming_scout_type = 'social' AND existing_scout_type IS DISTINCT FROM 'social')
  );
$$;

CREATE FUNCTION public.upsert_canonical_unit(
  p_user_id UUID,
  p_statement TEXT,
  p_type TEXT,
  p_entities TEXT[] DEFAULT NULL,
  p_embedding extensions.vector(1536) DEFAULT NULL,
  p_embedding_model TEXT DEFAULT 'gemini-embedding-2-preview',
  p_source_url TEXT DEFAULT NULL,
  p_normalized_source_url TEXT DEFAULT NULL,
  p_source_domain TEXT DEFAULT NULL,
  p_source_title TEXT DEFAULT NULL,
  p_context_excerpt TEXT DEFAULT NULL,
  p_occurred_at DATE DEFAULT NULL,
  p_extracted_at TIMESTAMPTZ DEFAULT NOW(),
  p_source_type TEXT DEFAULT 'scout',
  p_content_sha256 TEXT DEFAULT NULL,
  p_statement_hash TEXT DEFAULT NULL,
  p_scout_id UUID DEFAULT NULL,
  p_scout_type TEXT DEFAULT NULL,
  p_scout_run_id UUID DEFAULT NULL,
  p_project_id UUID DEFAULT NULL,
  p_raw_capture_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb,
  p_semantic_threshold REAL DEFAULT 0.93,
  p_semantic_anchor_threshold REAL DEFAULT 0.88,
  p_semantic_limit INT DEFAULT 25,
  p_fact_checked BOOLEAN DEFAULT FALSE,
  p_confidence_score REAL DEFAULT NULL,
  p_abstained BOOLEAN DEFAULT FALSE,
  p_abstain_reason TEXT DEFAULT NULL
)
RETURNS TABLE (
  unit_id UUID,
  created_canonical BOOLEAN,
  merged_existing BOOLEAN,
  match_scope TEXT,
  occurrence_created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_target_unit_id UUID;
  v_occurrence_id UUID;
  v_normalized_source_url TEXT;
  v_source_domain TEXT;
  v_entities TEXT[];
  v_existing_source BOOLEAN := FALSE;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;
  IF p_statement IS NULL OR btrim(p_statement) = '' THEN
    RAISE EXCEPTION 'p_statement is required';
  END IF;
  IF p_statement_hash IS NULL OR btrim(p_statement_hash) = '' THEN
    RAISE EXCEPTION 'p_statement_hash is required';
  END IF;
  IF p_type NOT IN ('fact', 'event', 'entity_update', 'promise') THEN
    RAISE EXCEPTION 'invalid unit type: %', p_type;
  END IF;
  IF p_source_type NOT IN ('scout', 'manual_ingest', 'agent_ingest', 'civic_promise') THEN
    RAISE EXCEPTION 'invalid source type: %', p_source_type;
  END IF;

  v_normalized_source_url := COALESCE(
    NULLIF(btrim(p_normalized_source_url), ''),
    normalize_source_url(p_source_url)
  );
  v_source_domain := NULLIF(btrim(p_source_domain), '');
  v_entities := text_array_union(NULL, p_entities);

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::TEXT || ':' || p_statement_hash, 0)
  );

  -- Exact identity is the normalized proposition, never the source document.
  IF p_scout_id IS NOT NULL THEN
    SELECT o.unit_id
    INTO v_target_unit_id
    FROM unit_occurrences o
    WHERE o.user_id = p_user_id
      AND o.scout_id = p_scout_id
      AND o.statement_hash = p_statement_hash
    ORDER BY o.extracted_at DESC
    LIMIT 1;

    IF v_target_unit_id IS NOT NULL THEN
      match_scope := 'same_scout';
    END IF;
  END IF;

  IF v_target_unit_id IS NULL THEN
    SELECT o.unit_id
    INTO v_target_unit_id
    FROM unit_occurrences o
    WHERE o.user_id = p_user_id
      AND o.statement_hash = p_statement_hash
    ORDER BY o.extracted_at DESC
    LIMIT 1;

    IF v_target_unit_id IS NOT NULL THEN
      match_scope := 'cross_scout_exact';
    END IF;
  END IF;

  IF v_target_unit_id IS NULL AND p_embedding IS NOT NULL THEN
    SELECT candidate.id
    INTO v_target_unit_id
    FROM (
      SELECT
        u.id,
        u.scout_type,
        u.source_domain,
        u.occurred_at,
        u.entities,
        (1 - (u.embedding <=> p_embedding))::REAL AS similarity
      FROM information_units u
      WHERE u.user_id = p_user_id
        AND u.embedding IS NOT NULL
      ORDER BY u.embedding <=> p_embedding
      LIMIT GREATEST(p_semantic_limit, 1)
    ) AS candidate
    WHERE allow_semantic_scout_match(candidate.scout_type, p_scout_type)
      AND (
        candidate.similarity >= p_semantic_threshold
        OR (
          candidate.similarity >= p_semantic_anchor_threshold
          AND (
            (v_source_domain IS NOT NULL AND candidate.source_domain = v_source_domain)
            OR (
              p_occurred_at IS NOT NULL
              AND candidate.occurred_at IS NOT NULL
              AND abs(candidate.occurred_at - p_occurred_at) <= 7
            )
            OR (
              COALESCE(candidate.entities, ARRAY[]::TEXT[]) &&
              COALESCE(v_entities, ARRAY[]::TEXT[])
            )
          )
        )
      )
    ORDER BY candidate.similarity DESC
    LIMIT 1;

    IF v_target_unit_id IS NOT NULL THEN
      match_scope := 'cross_scout_semantic';
    END IF;
  END IF;

  IF v_target_unit_id IS NULL THEN
    INSERT INTO information_units (
      user_id, scout_id, scout_type, statement, type, entities, embedding,
      source_url, source_domain, source_title, occurred_at, project_id,
      used_in_article, extracted_at, context_excerpt, source_type, raw_capture_id,
      embedding_model, first_seen_at, last_seen_at, occurrence_count, source_count,
      fact_checked, confidence_score, abstained, abstain_reason
    ) VALUES (
      p_user_id, p_scout_id, p_scout_type, p_statement, p_type, v_entities,
      p_embedding, p_source_url, v_source_domain, p_source_title, p_occurred_at,
      p_project_id, FALSE, COALESCE(p_extracted_at, NOW()), p_context_excerpt,
      p_source_type, p_raw_capture_id,
      COALESCE(p_embedding_model, 'gemini-embedding-2-preview'),
      COALESCE(p_extracted_at, NOW()), COALESCE(p_extracted_at, NOW()), 1, 1,
      p_fact_checked, p_confidence_score, p_abstained, p_abstain_reason
    )
    RETURNING id INTO v_target_unit_id;

    created_canonical := TRUE;
    merged_existing := FALSE;
    match_scope := 'new';
  ELSE
    created_canonical := FALSE;
    merged_existing := TRUE;

    IF p_fact_checked AND p_confidence_score IS NOT NULL AND (
      SELECT u.confidence_score IS NULL OR u.confidence_score < p_confidence_score
      FROM information_units u WHERE u.id = v_target_unit_id
    ) THEN
      UPDATE information_units
      SET fact_checked = TRUE,
          confidence_score = p_confidence_score,
          abstained = p_abstained,
          abstain_reason = p_abstain_reason
      WHERE id = v_target_unit_id;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM unit_occurrences o
      WHERE o.unit_id = v_target_unit_id
        AND (
          (v_normalized_source_url IS NOT NULL
            AND o.normalized_source_url = v_normalized_source_url)
          OR (v_normalized_source_url IS NULL
            AND p_content_sha256 IS NOT NULL
            AND o.content_sha256 = p_content_sha256)
        )
    ) INTO v_existing_source;
  END IF;

  INSERT INTO unit_occurrences (
    unit_id, user_id, project_id, scout_id, scout_run_id, raw_capture_id,
    scout_type, source_kind, source_url, normalized_source_url, source_title,
    source_domain, content_sha256, statement_hash, occurred_at, extracted_at,
    metadata
  ) VALUES (
    v_target_unit_id, p_user_id, p_project_id, p_scout_id, p_scout_run_id,
    p_raw_capture_id, p_scout_type, p_source_type, p_source_url,
    v_normalized_source_url, p_source_title, v_source_domain, p_content_sha256,
    p_statement_hash, p_occurred_at, COALESCE(p_extracted_at, NOW()),
    COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_occurrence_id;

  occurrence_created := v_occurrence_id IS NOT NULL;

  IF NOT created_canonical AND occurrence_created THEN
    UPDATE information_units
    SET
      last_seen_at = GREATEST(
        COALESCE(last_seen_at, p_extracted_at, NOW()),
        COALESCE(p_extracted_at, NOW())
      ),
      occurrence_count = COALESCE(occurrence_count, 1) + 1,
      source_count = COALESCE(source_count, 1) +
        CASE WHEN v_existing_source THEN 0 ELSE 1 END,
      type = canonical_unit_type(type, p_type),
      entities = text_array_union(entities, v_entities),
      occurred_at = COALESCE(occurred_at, p_occurred_at),
      context_excerpt = COALESCE(
        NULLIF(context_excerpt, ''), NULLIF(p_context_excerpt, '')
      ),
      source_url = COALESCE(NULLIF(source_url, ''), NULLIF(p_source_url, '')),
      source_title = COALESCE(
        NULLIF(source_title, ''), NULLIF(p_source_title, '')
      ),
      source_domain = COALESCE(NULLIF(source_domain, ''), v_source_domain),
      scout_id = COALESCE(scout_id, p_scout_id),
      scout_type = COALESCE(scout_type, p_scout_type),
      project_id = COALESCE(project_id, p_project_id),
      raw_capture_id = COALESCE(raw_capture_id, p_raw_capture_id),
      source_type = COALESCE(NULLIF(source_type, ''), p_source_type),
      embedding = COALESCE(embedding, p_embedding),
      embedding_model = CASE
        WHEN embedding IS NULL AND p_embedding IS NOT NULL
          THEN COALESCE(p_embedding_model, embedding_model)
        ELSE embedding_model
      END
    WHERE id = v_target_unit_id;
  END IF;

  unit_id := v_target_unit_id;
  RETURN NEXT;
END;
$$;

-- Read-only characterization query for migration operators:
-- SELECT u.id, count(DISTINCT o.statement_hash) AS statement_hashes
-- FROM information_units u JOIN unit_occurrences o ON o.unit_id = u.id
-- GROUP BY u.id HAVING count(DISTINCT o.statement_hash) > 1;
