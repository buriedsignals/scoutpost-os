-- Introduce EmbeddingGemma as a shadow vector space. Existing 1536d vectors
-- remain intact until the guarded backfill and application cutover complete.
-- New RPC names make it impossible for one query to compare the two spaces.

ALTER TABLE public.entities
  ADD COLUMN embedding_v2 extensions.vector(768),
  ADD COLUMN embedding_model_v2 TEXT;
ALTER TABLE public.reflections
  ADD COLUMN embedding_v2 extensions.vector(768),
  ADD COLUMN embedding_model_v2 TEXT;
ALTER TABLE public.information_units
  ADD COLUMN embedding_v2 extensions.vector(768),
  ADD COLUMN embedding_model_v2 TEXT;
ALTER TABLE public.execution_records
  ADD COLUMN embedding_v2 extensions.vector(768),
  ADD COLUMN embedding_model_v2 TEXT;

CREATE INDEX idx_entities_embedding_v2_hnsw
  ON public.entities USING hnsw (embedding_v2 extensions.vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding_v2 IS NOT NULL;
CREATE INDEX idx_reflections_embedding_v2_hnsw
  ON public.reflections USING hnsw (embedding_v2 extensions.vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding_v2 IS NOT NULL;
CREATE INDEX idx_information_units_embedding_v2_hnsw
  ON public.information_units USING hnsw (embedding_v2 extensions.vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding_v2 IS NOT NULL;
CREATE INDEX idx_execution_records_embedding_v2_hnsw
  ON public.execution_records USING hnsw (embedding_v2 extensions.vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding_v2 IS NOT NULL;

-- Semantic similarity is only a candidate generator. Conflicting structured
-- facts must never merge, even when their prose is nearly identical.
CREATE OR REPLACE FUNCTION public.semantic_unit_compatible(
  p_candidate_statement TEXT,
  p_candidate_occurred_at DATE,
  p_candidate_entities TEXT[],
  p_statement TEXT,
  p_occurred_at DATE,
  p_entities TEXT[]
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_candidate_numbers TEXT[];
  v_input_numbers TEXT[];
  v_candidate_negative BOOLEAN;
  v_input_negative BOOLEAN;
  v_candidate_entities TEXT[];
  v_input_entities TEXT[];
BEGIN
  IF p_candidate_occurred_at IS NOT NULL AND p_occurred_at IS NOT NULL
     AND abs(p_candidate_occurred_at - p_occurred_at) > 1 THEN
    RETURN FALSE;
  END IF;

  SELECT array_agg(DISTINCT lower(btrim(value)) ORDER BY lower(btrim(value)))
    INTO v_candidate_entities
  FROM unnest(COALESCE(p_candidate_entities, ARRAY[]::TEXT[])) AS value
  WHERE btrim(value) <> '';
  SELECT array_agg(DISTINCT lower(btrim(value)) ORDER BY lower(btrim(value)))
    INTO v_input_entities
  FROM unnest(COALESCE(p_entities, ARRAY[]::TEXT[])) AS value
  WHERE btrim(value) <> '';
  IF cardinality(v_candidate_entities) > 0 AND cardinality(v_input_entities) > 0
     AND NOT v_candidate_entities && v_input_entities THEN
    RETURN FALSE;
  END IF;

  SELECT array_agg(DISTINCT match[1] ORDER BY match[1])
    INTO v_candidate_numbers
  FROM regexp_matches(
    lower(COALESCE(p_candidate_statement, '')),
    '([0-9]+(?:[.,][0-9]+)?%?)',
    'g'
  ) AS match;
  SELECT array_agg(DISTINCT match[1] ORDER BY match[1])
    INTO v_input_numbers
  FROM regexp_matches(
    lower(COALESCE(p_statement, '')),
    '([0-9]+(?:[.,][0-9]+)?%?)',
    'g'
  ) AS match;
  IF cardinality(v_candidate_numbers) > 0 AND cardinality(v_input_numbers) > 0
     AND v_candidate_numbers <> v_input_numbers THEN
    RETURN FALSE;
  END IF;

  v_candidate_negative := lower(COALESCE(p_candidate_statement, '')) ~
    '\m(no|not|never|reject(?:ed|s|ing)?|fail(?:ed|s|ing)?|cancel(?:led|ed|s|ing)?|deny|denied|oppos(?:e|ed|es|ing))\M';
  v_input_negative := lower(COALESCE(p_statement, '')) ~
    '\m(no|not|never|reject(?:ed|s|ing)?|fail(?:ed|s|ing)?|cancel(?:led|ed|s|ing)?|deny|denied|oppos(?:e|ed|es|ing))\M';
  IF v_candidate_negative <> v_input_negative THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END
$function$;

-- Clone the current, fact-check-aware canonical upsert into the shadow space.
-- Word-boundary replacements cannot touch p_embedding/p_embedding_model.
DO $migration$
DECLARE
  v_definition TEXT;
  v_original TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_original
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'upsert_canonical_unit'
    AND p.pronargs = 29;

  IF v_original IS NULL THEN
    RAISE EXCEPTION 'public.upsert_canonical_unit/29 definition not found';
  END IF;

  v_definition := replace(
    v_original,
    'FUNCTION public.upsert_canonical_unit(',
    'FUNCTION public.upsert_canonical_unit_v2('
  );
  v_definition := replace(
    v_definition,
    'extensions.vector(1536)',
    'extensions.vector(768)'
  );
  v_definition := replace(v_definition, 'vector(1536)', 'extensions.vector(768)');
  v_definition := replace(
    v_definition,
    'gemini-embedding-2-preview',
    'embeddinggemma-300m-768-int8-onnx-task-prefix-v1'
  );
  v_definition := replace(
    v_definition,
    'p_semantic_threshold real DEFAULT 0.93',
    'p_semantic_threshold real DEFAULT 0.82'
  );
  v_definition := replace(
    v_definition,
    'p_semantic_anchor_threshold real DEFAULT 0.88',
    'p_semantic_anchor_threshold real DEFAULT 0.82'
  );
  v_definition := regexp_replace(v_definition, '\membedding_model\M', 'embedding_model_v2', 'g');
  v_definition := regexp_replace(v_definition, '\membedding\M', 'embedding_v2', 'g');
  v_definition := replace(
    v_definition,
    '        u.source_domain,',
    E'        u.statement,\n        u.source_domain,'
  );
  v_definition := replace(
    v_definition,
    '    WHERE allow_semantic_scout_match(candidate.scout_type, p_scout_type)',
    E'    WHERE allow_semantic_scout_match(candidate.scout_type, p_scout_type)\n      AND semantic_unit_compatible(\n        candidate.statement, candidate.occurred_at, candidate.entities,\n        p_statement, p_occurred_at, v_entities\n      )'
  );

  IF v_definition = v_original
     OR position('upsert_canonical_unit_v2' IN v_definition) = 0
     OR position('embedding_v2' IN v_definition) = 0
     OR position('semantic_unit_compatible' IN v_definition) = 0
     OR position('p_semantic_threshold real DEFAULT 0.82' IN v_definition) = 0
     OR position('p_semantic_anchor_threshold real DEFAULT 0.82' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'failed to construct EmbeddingGemma shadow upsert';
  END IF;
  EXECUTE v_definition;
END
$migration$;

CREATE OR REPLACE FUNCTION public.semantic_search_units_v2(
  p_embedding  extensions.vector(768) DEFAULT NULL,
  p_user_id    UUID         DEFAULT NULL,
  p_project_id UUID         DEFAULT NULL,
  p_scout_id   UUID         DEFAULT NULL,
  p_limit      INT          DEFAULT 20,
  p_query_text TEXT         DEFAULT NULL,
  p_rrf_k      INT          DEFAULT 50
)
RETURNS TABLE (
  id UUID, statement TEXT, context_excerpt TEXT, unit_type TEXT,
  occurred_at DATE, extracted_at TIMESTAMPTZ, project_id UUID,
  similarity REAL, semantic_similarity REAL
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $function$
  WITH scoped_units AS (
    SELECT u.* FROM information_units u
    WHERE u.user_id = p_user_id
      AND (
        (p_project_id IS NULL AND p_scout_id IS NULL)
        OR EXISTS (
          SELECT 1 FROM unit_occurrences o
          WHERE o.unit_id = u.id AND o.user_id = p_user_id
            AND (p_project_id IS NULL OR o.project_id = p_project_id)
            AND (p_scout_id IS NULL OR o.scout_id = p_scout_id)
        )
      )
  ), fulltext AS (
    SELECT u.id, row_number() OVER (
      ORDER BY ts_rank_cd(u.fts, websearch_to_tsquery('english', p_query_text)) DESC
    ) AS rank_ix
    FROM scoped_units u
    WHERE p_query_text IS NOT NULL AND p_query_text <> ''
      AND u.fts @@ websearch_to_tsquery('english', p_query_text)
    ORDER BY rank_ix LIMIT greatest(p_limit, 1) * 2
  ), semantic AS (
    SELECT u.id,
      row_number() OVER (ORDER BY u.embedding_v2 <=> p_embedding) AS rank_ix,
      (1 - (u.embedding_v2 <=> p_embedding))::REAL AS semantic_similarity
    FROM scoped_units u
    WHERE p_embedding IS NOT NULL AND u.embedding_v2 IS NOT NULL
    ORDER BY rank_ix LIMIT greatest(p_limit, 1) * 2
  ), merged AS (
    SELECT COALESCE(f.id, s.id) AS id,
      COALESCE(1.0 / (p_rrf_k + f.rank_ix), 0.0) +
        COALESCE(1.0 / (p_rrf_k + s.rank_ix), 0.0) AS rrf_score,
      s.semantic_similarity
    FROM fulltext f FULL OUTER JOIN semantic s ON s.id = f.id
  )
  SELECT u.id, u.statement, u.context_excerpt, u.type,
    u.occurred_at, COALESCE(u.last_seen_at, u.extracted_at),
    COALESCE(p_project_id, (
      SELECT o.project_id FROM unit_occurrences o
      WHERE o.unit_id = u.id AND o.user_id = p_user_id AND o.project_id IS NOT NULL
      ORDER BY o.extracted_at DESC LIMIT 1
    ), u.project_id),
    m.rrf_score::REAL, m.semantic_similarity::REAL
  FROM merged m JOIN scoped_units u ON u.id = m.id
  ORDER BY m.rrf_score DESC LIMIT p_limit;
$function$;

CREATE OR REPLACE FUNCTION public.semantic_search_reflections_v2(
  p_embedding extensions.vector(768), p_user_id UUID,
  p_project_id UUID DEFAULT NULL, p_limit INT DEFAULT 20
)
RETURNS TABLE (
  id UUID, scope_description TEXT, content TEXT, project_id UUID,
  time_range_start TIMESTAMPTZ, time_range_end TIMESTAMPTZ,
  generated_by TEXT, created_at TIMESTAMPTZ, similarity REAL
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $function$
  SELECT r.id, r.scope_description, r.content, r.project_id,
    r.time_range_start, r.time_range_end, r.generated_by, r.created_at,
    1 - (r.embedding_v2 <=> p_embedding)
  FROM reflections r
  WHERE r.user_id = p_user_id AND r.embedding_v2 IS NOT NULL
    AND (p_project_id IS NULL OR r.project_id = p_project_id)
  ORDER BY r.embedding_v2 <=> p_embedding LIMIT p_limit;
$function$;

CREATE OR REPLACE FUNCTION public.write_embedding_v2(
  p_table TEXT,
  p_id UUID,
  p_embedding extensions.vector(768),
  p_model TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_model <> 'embeddinggemma-300m-768-int8-onnx-task-prefix-v1' THEN
    RAISE EXCEPTION 'unapproved embedding model tag';
  END IF;
  IF p_table NOT IN ('entities', 'reflections', 'information_units', 'execution_records') THEN
    RAISE EXCEPTION 'unsupported embedding table';
  END IF;
  EXECUTE format(
    'UPDATE public.%I SET embedding_v2 = $1, embedding_model_v2 = $2 '
      'WHERE id = $3 AND embedding_v2 IS NULL',
    p_table
  ) USING p_embedding, p_model, p_id;
END
$function$;

REVOKE ALL ON FUNCTION public.write_embedding_v2(TEXT, UUID, extensions.vector, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_embedding_v2(TEXT, UUID, extensions.vector, TEXT)
  TO service_role;

-- Every v2 RPC accepts an explicit user id or writes canonical data. They are
-- server-internal boundaries: leaving PostgreSQL's default PUBLIC execute
-- privilege in place would let a direct PostgREST caller bypass the Edge
-- authorization checks by supplying another user's id.
DO $privileges$
DECLARE
  v_function REGPROCEDURE;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'upsert_canonical_unit_v2',
        'semantic_search_units_v2',
        'semantic_search_reflections_v2'
      )
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',
      v_function
    );
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_function);
  END LOOP;
END
$privileges$;
