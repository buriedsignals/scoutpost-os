-- Keep the existing vector(768) schema while replacing the model space with
-- OpenRouter-routed Gemini Embedding 001. Vectors are staged separately and
-- copied into the live columns only after every non-target row is covered.

CREATE TABLE public.embedding_v2_cutover_stage (
  table_name TEXT NOT NULL CHECK (
    table_name IN ('entities', 'reflections', 'information_units', 'execution_records')
  ),
  row_id UUID NOT NULL,
  embedding extensions.vector(768) NOT NULL,
  embedding_model TEXT NOT NULL,
  staged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (table_name, row_id)
);

REVOKE ALL ON TABLE public.embedding_v2_cutover_stage
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.embedding_v2_cutover_stage
  TO service_role;

-- Keep semantic matching inside a single model space. The application always
-- passes its model tag; the old local tag remains the SQL default so the
-- existing deployment continues to work until the Edge cutover.
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
    AND p.proname = 'upsert_canonical_unit_v2'
    AND p.pronargs = 29;

  IF v_original IS NULL THEN
    RAISE EXCEPTION 'public.upsert_canonical_unit_v2/29 definition not found';
  END IF;

  v_definition := replace(
    v_original,
    'embeddinggemma-300m-768-int8-onnx-task-prefix-v1',
    'openrouter-google-gemini-embedding-001-768-zdr-v1'
  );
  v_definition := replace(
    v_definition,
    'p_semantic_threshold real DEFAULT 0.82',
    'p_semantic_threshold real DEFAULT 0.90'
  );
  v_definition := replace(
    v_definition,
    'p_semantic_anchor_threshold real DEFAULT 0.82',
    'p_semantic_anchor_threshold real DEFAULT 0.90'
  );
  v_definition := replace(
    v_definition,
    E'      WHERE u.user_id = p_user_id\n        AND u.embedding_v2 IS NOT NULL',
    E'      WHERE u.user_id = p_user_id\n        AND u.embedding_v2 IS NOT NULL\n        AND u.embedding_model_v2 = p_embedding_model'
  );

  IF position('embedding_model_v2 = p_embedding_model' IN v_definition) = 0
     OR position('p_semantic_threshold real DEFAULT 0.90' IN v_definition) = 0
     OR position('p_semantic_anchor_threshold real DEFAULT 0.90' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'failed to construct model-isolated OpenRouter upsert';
  END IF;
  EXECUTE v_definition;
END
$migration$;

DROP FUNCTION public.semantic_search_units_v2(
  extensions.vector, UUID, UUID, UUID, INT, TEXT, INT
);

CREATE FUNCTION public.semantic_search_units_v2(
  p_embedding  extensions.vector(768) DEFAULT NULL,
  p_user_id    UUID         DEFAULT NULL,
  p_project_id UUID         DEFAULT NULL,
  p_scout_id   UUID         DEFAULT NULL,
  p_limit      INT          DEFAULT 20,
  p_query_text TEXT         DEFAULT NULL,
  p_rrf_k      INT          DEFAULT 50,
  p_embedding_model TEXT DEFAULT 'embeddinggemma-300m-768-int8-onnx-task-prefix-v1'
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
      AND u.embedding_model_v2 = p_embedding_model
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

DROP FUNCTION public.semantic_search_reflections_v2(
  extensions.vector, UUID, UUID, INT
);

CREATE FUNCTION public.semantic_search_reflections_v2(
  p_embedding extensions.vector(768), p_user_id UUID,
  p_project_id UUID DEFAULT NULL, p_limit INT DEFAULT 20,
  p_embedding_model TEXT DEFAULT 'embeddinggemma-300m-768-int8-onnx-task-prefix-v1'
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
    AND r.embedding_model_v2 = p_embedding_model
    AND (p_project_id IS NULL OR r.project_id = p_project_id)
  ORDER BY r.embedding_v2 <=> p_embedding LIMIT p_limit;
$function$;

CREATE OR REPLACE FUNCTION public.stage_embedding_v2_cutover(
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
  IF p_model <> 'openrouter-google-gemini-embedding-001-768-zdr-v1' THEN
    RAISE EXCEPTION 'unapproved cutover embedding model tag';
  END IF;
  IF p_table NOT IN ('entities', 'reflections', 'information_units', 'execution_records') THEN
    RAISE EXCEPTION 'unsupported embedding table';
  END IF;
  INSERT INTO public.embedding_v2_cutover_stage (
    table_name, row_id, embedding, embedding_model, staged_at
  ) VALUES (p_table, p_id, p_embedding, p_model, NOW())
  ON CONFLICT (table_name, row_id) DO UPDATE
    SET embedding = EXCLUDED.embedding,
        embedding_model = EXCLUDED.embedding_model,
        staged_at = NOW();
END
$function$;

CREATE OR REPLACE FUNCTION public.embedding_v2_cutover_inventory()
RETURNS TABLE (
  table_name TEXT,
  total BIGINT,
  live_target BIGINT,
  staged BIGINT,
  remaining BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_table TEXT;
  v_target CONSTANT TEXT := 'openrouter-google-gemini-embedding-001-768-zdr-v1';
BEGIN
  FOR v_table IN SELECT unnest(ARRAY[
    'entities', 'reflections', 'information_units', 'execution_records'
  ]) LOOP
    table_name := v_table;
    EXECUTE format('SELECT count(*) FROM public.%I', v_table) INTO total;
    EXECUTE format(
      'SELECT count(*) FROM public.%I WHERE embedding_model_v2 = $1',
      v_table
    ) INTO live_target USING v_target;
    EXECUTE format(
      'SELECT count(*) FROM public.%I source '
      'WHERE source.embedding_model_v2 IS DISTINCT FROM $1 '
      'AND EXISTS ('
      '  SELECT 1 FROM public.embedding_v2_cutover_stage stage '
      '  WHERE stage.table_name = $2 AND stage.row_id = source.id '
      '    AND stage.embedding_model = $1'
      ')',
      v_table
    ) INTO staged USING v_target, v_table;
    EXECUTE format(
      'SELECT count(*) FROM public.%I source '
      'WHERE source.embedding_model_v2 IS DISTINCT FROM $1 '
      'AND NOT EXISTS ('
      '  SELECT 1 FROM public.embedding_v2_cutover_stage stage '
      '  WHERE stage.table_name = $2 AND stage.row_id = source.id '
      '    AND stage.embedding_model = $1'
      ')',
      v_table
    ) INTO remaining USING v_target, v_table;
    RETURN NEXT;
  END LOOP;
END
$function$;

CREATE OR REPLACE FUNCTION public.apply_embedding_v2_cutover()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_table TEXT;
  v_missing BIGINT;
  v_updated BIGINT;
  v_counts JSONB := '{}'::JSONB;
  v_target CONSTANT TEXT := 'openrouter-google-gemini-embedding-001-768-zdr-v1';
BEGIN
  -- Block concurrent inserts/updates for the short completeness-check/apply
  -- window. Reads continue; new-model writers resume after this transaction.
  LOCK TABLE public.entities, public.reflections, public.information_units,
    public.execution_records IN SHARE ROW EXCLUSIVE MODE;

  FOR v_table IN SELECT unnest(ARRAY[
    'entities', 'reflections', 'information_units', 'execution_records'
  ]) LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I source '
      'WHERE source.embedding_model_v2 IS DISTINCT FROM $1 '
      'AND NOT EXISTS ('
      '  SELECT 1 FROM public.embedding_v2_cutover_stage stage '
      '  WHERE stage.table_name = $2 AND stage.row_id = source.id '
      '    AND stage.embedding_model = $1'
      ')',
      v_table
    ) INTO v_missing USING v_target, v_table;
    IF v_missing <> 0 THEN
      RAISE EXCEPTION '% rows in % are not staged for the target model',
        v_missing, v_table;
    END IF;
  END LOOP;

  FOR v_table IN SELECT unnest(ARRAY[
    'entities', 'reflections', 'information_units', 'execution_records'
  ]) LOOP
    EXECUTE format(
      'UPDATE public.%I target '
      'SET embedding_v2 = stage.embedding, embedding_model_v2 = stage.embedding_model '
      'FROM public.embedding_v2_cutover_stage stage '
      'WHERE stage.table_name = $1 AND stage.row_id = target.id '
      '  AND stage.embedding_model = $2 '
      '  AND target.embedding_model_v2 IS DISTINCT FROM $2',
      v_table
    ) USING v_table, v_target;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object(v_table, v_updated);
  END LOOP;

  DELETE FROM public.embedding_v2_cutover_stage
  WHERE embedding_model = v_target;
  RETURN jsonb_build_object('model', v_target, 'updated', v_counts);
END
$function$;

REVOKE ALL ON FUNCTION public.semantic_search_units_v2(
  extensions.vector, UUID, UUID, UUID, INT, TEXT, INT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.semantic_search_units_v2(
  extensions.vector, UUID, UUID, UUID, INT, TEXT, INT, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION public.semantic_search_reflections_v2(
  extensions.vector, UUID, UUID, INT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.semantic_search_reflections_v2(
  extensions.vector, UUID, UUID, INT, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION public.stage_embedding_v2_cutover(
  TEXT, UUID, extensions.vector, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stage_embedding_v2_cutover(
  TEXT, UUID, extensions.vector, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION public.embedding_v2_cutover_inventory()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.embedding_v2_cutover_inventory()
  TO service_role;

REVOKE ALL ON FUNCTION public.apply_embedding_v2_cutover()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_embedding_v2_cutover()
  TO service_role;
