-- Exact, reviewable source passages. A source expression is an immutable
-- slice of the raw capture that produced a canonical information unit.

CREATE TABLE public.source_expressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  raw_capture_id UUID NOT NULL REFERENCES public.raw_captures(id) ON DELETE CASCADE,
  exact_text TEXT NOT NULL CHECK (length(exact_text) > 0),
  start_byte INTEGER NOT NULL CHECK (start_byte >= 0),
  end_byte INTEGER NOT NULL CHECK (end_byte > start_byte),
  start_line INTEGER NOT NULL CHECK (start_line >= 1),
  end_line INTEGER NOT NULL CHECK (end_line >= start_line),
  locator_version TEXT NOT NULL DEFAULT 'raw-md-utf8-byte-v1',
  capture_payload_sha256 TEXT NOT NULL,
  passage_sha256 TEXT NOT NULL,
  passage_fingerprint TEXT NOT NULL,
  language TEXT,
  attribution TEXT,
  is_direct_quote BOOLEAN NOT NULL DEFAULT FALSE,
  segmentation_version TEXT NOT NULL DEFAULT 'line-window-v1',
  extractor_version TEXT,
  prompt_version TEXT,
  validation_version TEXT NOT NULL DEFAULT 'exact-byte-v1',
  lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active', 'superseded', 'rejected')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (raw_capture_id, start_byte, end_byte, locator_version)
);

CREATE INDEX idx_source_expressions_user_capture
  ON public.source_expressions(user_id, raw_capture_id);
CREATE INDEX idx_source_expressions_passage_sha
  ON public.source_expressions(passage_sha256);

CREATE TABLE public.source_expression_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_expression_id UUID NOT NULL REFERENCES public.source_expressions(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES public.information_units(id) ON DELETE CASCADE,
  unit_occurrence_id UUID REFERENCES public.unit_occurrences(id) ON DELETE SET NULL,
  relation_kind TEXT NOT NULL CHECK (relation_kind IN ('supports', 'contradicts', 'context')),
  link_method TEXT NOT NULL DEFAULT 'extraction'
    CHECK (link_method IN ('extraction', 'human_review', 'agent_review')),
  review_status TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (review_status IN ('unreviewed', 'accepted', 'rejected')),
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_expression_id, unit_id, relation_kind)
);

CREATE INDEX idx_source_expression_links_unit
  ON public.source_expression_links(unit_id, created_at DESC);
CREATE INDEX idx_source_expression_links_user_unit
  ON public.source_expression_links(user_id, unit_id);

ALTER TABLE public.source_expressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_expression_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY source_expressions_owner ON public.source_expressions
  FOR SELECT USING (user_id = (SELECT auth.uid()));
CREATE POLICY source_expression_links_owner ON public.source_expression_links
  FOR SELECT USING (user_id = (SELECT auth.uid()));

-- Evidence anchors are derived by the RPC below. Direct mutation would make
-- an apparently validated quote point at different source text.
REVOKE INSERT, UPDATE, DELETE ON public.source_expressions FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.source_expression_links FROM anon, authenticated;
-- Captures remain caller-insertable, but once present may only be changed or
-- removed by trusted backend/retention jobs. This prevents direct clients from
-- invalidating an anchor before the immutability trigger can protect it.
REVOKE UPDATE, DELETE ON public.raw_captures FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.prevent_source_expression_core_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.raw_capture_id IS DISTINCT FROM OLD.raw_capture_id
     OR NEW.exact_text IS DISTINCT FROM OLD.exact_text
     OR NEW.start_byte IS DISTINCT FROM OLD.start_byte
     OR NEW.end_byte IS DISTINCT FROM OLD.end_byte
     OR NEW.start_line IS DISTINCT FROM OLD.start_line
     OR NEW.end_line IS DISTINCT FROM OLD.end_line
     OR NEW.locator_version IS DISTINCT FROM OLD.locator_version
     OR NEW.capture_payload_sha256 IS DISTINCT FROM OLD.capture_payload_sha256
     OR NEW.passage_sha256 IS DISTINCT FROM OLD.passage_sha256
     OR NEW.passage_fingerprint IS DISTINCT FROM OLD.passage_fingerprint THEN
    RAISE EXCEPTION 'source expression core fields are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER source_expression_core_immutable
  BEFORE UPDATE ON public.source_expressions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_source_expression_core_mutation();

CREATE OR REPLACE FUNCTION public.prevent_raw_capture_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.content_md IS DISTINCT FROM OLD.content_md
     AND EXISTS (SELECT 1 FROM public.source_expressions WHERE raw_capture_id = OLD.id) THEN
    RAISE EXCEPTION 'raw capture content is immutable after source expressions exist';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER raw_capture_evidence_immutable
  BEFORE UPDATE ON public.raw_captures
  FOR EACH ROW EXECUTE FUNCTION public.prevent_raw_capture_evidence_mutation();

CREATE OR REPLACE FUNCTION public.record_source_expression(
  p_user_id UUID,
  p_raw_capture_id UUID,
  p_unit_id UUID,
  p_unit_occurrence_id UUID,
  p_start_byte INTEGER,
  p_end_byte INTEGER,
  p_relation_kind TEXT DEFAULT 'supports',
  p_language TEXT DEFAULT NULL,
  p_attribution TEXT DEFAULT NULL,
  p_is_direct_quote BOOLEAN DEFAULT FALSE,
  p_extractor_version TEXT DEFAULT NULL,
  p_prompt_version TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_content TEXT;
  v_content_bytes BYTEA;
  v_exact BYTEA;
  v_expression_id UUID;
  v_start_line INTEGER;
  v_end_line INTEGER;
  v_capture_hash TEXT;
  v_passage_hash TEXT;
BEGIN
  IF p_start_byte IS NULL OR p_end_byte IS NULL OR p_start_byte < 0 OR p_end_byte <= p_start_byte THEN
    RAISE EXCEPTION 'invalid source expression byte range';
  END IF;
  SELECT content_md INTO v_content FROM raw_captures
  WHERE id = p_raw_capture_id AND user_id = p_user_id;
  IF NOT FOUND OR v_content IS NULL THEN RAISE EXCEPTION 'raw capture not found'; END IF;
  PERFORM 1 FROM information_units WHERE id = p_unit_id AND user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'information unit not found'; END IF;
  IF p_unit_occurrence_id IS NULL THEN
    SELECT id INTO p_unit_occurrence_id FROM unit_occurrences
    WHERE unit_id = p_unit_id AND user_id = p_user_id
      AND raw_capture_id = p_raw_capture_id
    ORDER BY extracted_at DESC
    LIMIT 1;
  END IF;
  IF p_unit_occurrence_id IS NOT NULL THEN
    PERFORM 1 FROM unit_occurrences
    WHERE id = p_unit_occurrence_id AND unit_id = p_unit_id AND user_id = p_user_id
      AND raw_capture_id = p_raw_capture_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'unit occurrence does not match source expression'; END IF;
  END IF;

  v_content_bytes := convert_to(v_content, 'UTF8');
  IF p_end_byte > octet_length(v_content_bytes) THEN
    RAISE EXCEPTION 'source expression byte range exceeds raw capture';
  END IF;
  v_exact := substring(v_content_bytes FROM p_start_byte + 1 FOR p_end_byte - p_start_byte);
  IF convert_from(v_exact, 'UTF8') IS NULL OR octet_length(v_exact) = 0 THEN
    RAISE EXCEPTION 'source expression must contain valid UTF-8 text';
  END IF;

  v_start_line := 1 + length(regexp_replace(convert_from(substring(v_content_bytes FROM 1 FOR p_start_byte), 'UTF8'), E'[^\\n]', '', 'g'));
  v_end_line := v_start_line + length(regexp_replace(convert_from(v_exact, 'UTF8'), E'[^\\n]', '', 'g'));
  v_capture_hash := encode(extensions.digest(v_content_bytes, 'sha256'), 'hex');
  v_passage_hash := encode(extensions.digest(v_exact, 'sha256'), 'hex');

  INSERT INTO source_expressions (
    user_id, raw_capture_id, exact_text, start_byte, end_byte, start_line, end_line,
    capture_payload_sha256, passage_sha256, passage_fingerprint, language, attribution,
    is_direct_quote, extractor_version, prompt_version, metadata
  ) VALUES (
    p_user_id, p_raw_capture_id, convert_from(v_exact, 'UTF8'), p_start_byte, p_end_byte,
    v_start_line, v_end_line, v_capture_hash, v_passage_hash,
    left(v_passage_hash, 24), p_language, p_attribution, p_is_direct_quote,
    p_extractor_version, p_prompt_version, COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (raw_capture_id, start_byte, end_byte, locator_version)
  DO UPDATE SET lifecycle_status = source_expressions.lifecycle_status
  RETURNING id INTO v_expression_id;

  INSERT INTO source_expression_links (
    user_id, source_expression_id, unit_id, unit_occurrence_id, relation_kind
  ) VALUES (p_user_id, v_expression_id, p_unit_id, p_unit_occurrence_id, p_relation_kind)
  ON CONFLICT (source_expression_id, unit_id, relation_kind) DO NOTHING;
  RETURN v_expression_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_source_expression(
  UUID, UUID, UUID, UUID, INTEGER, INTEGER, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_source_expression(
  UUID, UUID, UUID, UUID, INTEGER, INTEGER, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, JSONB
) TO service_role;

CREATE OR REPLACE FUNCTION public.review_source_expression_link(
  p_user_id UUID,
  p_link_id UUID,
  p_review_status TEXT,
  p_review_notes TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE source_expression_links
  SET review_status = p_review_status, reviewed_by = p_user_id,
      reviewed_at = now(), review_notes = p_review_notes, link_method = 'human_review'
  WHERE id = p_link_id AND user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'source expression link not found'; END IF;
END;
$$;

CREATE OR REPLACE VIEW public.unit_evidence_status
WITH (security_invoker = true) AS
SELECT
  l.unit_id,
  count(*) FILTER (WHERE e.lifecycle_status = 'active') AS active_expression_count,
  count(*) FILTER (WHERE l.relation_kind = 'supports' AND l.review_status = 'accepted'
    AND e.lifecycle_status = 'active') AS accepted_support_count,
  bool_or(l.review_status = 'rejected' OR e.lifecycle_status = 'rejected') AS has_rejected_evidence
FROM source_expression_links l
JOIN source_expressions e ON e.id = l.source_expression_id
GROUP BY l.unit_id;
