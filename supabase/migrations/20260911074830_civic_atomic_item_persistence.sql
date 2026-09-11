-- Item outcomes survive a document retry; document finalization remains the
-- exactly-once counter boundary. The existing alert ledger only holds promises.
CREATE TABLE public.civic_queue_item_results (
  queue_id uuid NOT NULL REFERENCES public.civic_extraction_queue(id) ON DELETE CASCADE,
  statement_hash text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES public.information_units(id) ON DELETE CASCADE,
  request_identity jsonb NOT NULL,
  created_canonical boolean NOT NULL,
  merged_existing boolean NOT NULL,
  occurrence_created boolean NOT NULL,
  match_scope text NOT NULL,
  PRIMARY KEY (queue_id, statement_hash)
);
ALTER TABLE public.civic_queue_item_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.civic_queue_item_results FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.civic_queue_item_results TO service_role;

CREATE FUNCTION public.persist_civic_item(p_queue_id uuid, p_worker_id text, p_input jsonb)
RETURNS TABLE(unit_id uuid, created_canonical boolean, merged_existing boolean,
              match_scope text, occurrence_created boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, extensions AS $$
DECLARE
  q public.civic_extraction_queue%ROWTYPE;
  prior public.civic_queue_item_results%ROWTYPE;
  tracker public.promises%ROWTYPE;
  result record;
  revision_id uuid;
  identity jsonb;
  meta jsonb := p_input->'p_metadata';
BEGIN
  SELECT * INTO q FROM public.civic_extraction_queue
   WHERE id = p_queue_id FOR UPDATE;
  IF NOT FOUND OR q.status <> 'processing' OR q.lease_owner IS DISTINCT FROM p_worker_id
     OR q.lease_expires_at IS NULL OR q.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Civic item persistence requires an active owned queue lease';
  END IF;
  IF q.ingestion_mode NOT IN ('initial', 'scheduled') THEN
    RAISE EXCEPTION 'Civic repair requires its exact-target repair workflow';
  END IF;
  IF (p_input->>'p_user_id')::uuid IS DISTINCT FROM q.user_id
     OR (p_input->>'p_scout_id')::uuid IS DISTINCT FROM q.scout_id
     OR (p_input->>'p_scout_run_id')::uuid IS DISTINCT FROM q.scout_run_id
     OR p_input->>'p_source_url' IS DISTINCT FROM q.source_url
     OR p_input->>'p_scout_type' IS DISTINCT FROM 'civic'
     OR p_input->>'p_type' NOT IN ('promise', 'fact')
     OR COALESCE(p_input->>'p_statement_hash', '') = '' THEN
    RAISE EXCEPTION 'Civic item provenance does not match queue';
  END IF;
  identity := p_input - ARRAY['p_embedding', 'p_embedding_model', 'p_extracted_at', 'p_raw_capture_id'];
  SELECT * INTO prior FROM public.civic_queue_item_results
   WHERE queue_id = q.id AND statement_hash = p_input->>'p_statement_hash';
  IF FOUND THEN
    IF prior.request_identity IS DISTINCT FROM identity THEN
      RAISE EXCEPTION 'Civic retry changed the accepted item';
    END IF;
    RETURN QUERY SELECT prior.unit_id, prior.created_canonical,
      prior.merged_existing, prior.match_scope, prior.occurrence_created;
    RETURN;
  END IF;
  IF p_input->>'p_type' = 'promise' AND (
     NULLIF(meta->>'due_date', '') IS NULL OR NULLIF(meta->>'due_date_text', '') IS NULL
     OR COALESCE(meta->>'date_confidence', '') NOT IN ('high', 'medium', 'low')) THEN
    RAISE EXCEPTION 'new Civic promise is missing required revision fields';
  END IF;
  SELECT * INTO result FROM public.upsert_canonical_unit_v2(
    p_user_id => q.user_id,
    p_statement => p_input->>'p_statement', p_type => p_input->>'p_type',
    p_entities => ARRAY(SELECT jsonb_array_elements_text(p_input->'p_entities')),
    p_embedding => NULLIF(p_input->>'p_embedding','null')::extensions.vector(768),
    p_embedding_model => p_input->>'p_embedding_model',
    p_source_url => q.source_url, p_normalized_source_url => p_input->>'p_normalized_source_url',
    p_source_domain => p_input->>'p_source_domain', p_source_title => p_input->>'p_source_title',
    p_context_excerpt => p_input->>'p_context_excerpt',
    p_occurred_at => (p_input->>'p_occurred_at')::date,
    p_extracted_at => (p_input->>'p_extracted_at')::timestamptz,
    p_source_type => p_input->>'p_source_type', p_content_sha256 => p_input->>'p_content_sha256',
    p_statement_hash => p_input->>'p_statement_hash',
    p_scout_id => q.scout_id, p_scout_type => 'civic', p_scout_run_id => q.scout_run_id,
    p_project_id => (p_input->>'p_project_id')::uuid,
    p_raw_capture_id => (p_input->>'p_raw_capture_id')::uuid,
    p_metadata => meta, p_fact_checked => false
  );
  -- Dedup deliberately retains the user's deletion; never recreate a tracker
  -- or send an alert for an already-deleted canonical item.
  IF EXISTS (SELECT 1 FROM public.information_units u
             WHERE u.id = result.unit_id AND u.user_id = q.user_id AND u.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Civic extraction matched a deleted canonical item';
  END IF;
  IF p_input->>'p_type' = 'promise' THEN
    SELECT * INTO tracker FROM public.promises p
     WHERE p.user_id = q.user_id AND p.unit_id = result.unit_id FOR UPDATE;
    IF FOUND THEN
      -- No inferred repair or modification of editorial status/deadline history.
      IF tracker.active_revision_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.promise_revisions r WHERE r.id = tracker.active_revision_id
        AND r.promise_id = tracker.id AND r.user_id = q.user_id
      ) THEN
        RAISE EXCEPTION 'Existing Civic tracker needs an explicit revision repair';
      END IF;
    ELSE
      -- A first Civic occurrence may promote an existing Page/Beat finding
      -- (or a Civic decision) using the current verified promise evidence.
      -- Earlier Civic promise evidence without a tracker remains an explicit
      -- repair case, including when the canonical kept Page/Beat provenance.
      IF NOT result.created_canonical AND (
        EXISTS (SELECT 1 FROM public.information_units u
          WHERE u.id = result.unit_id AND u.user_id = q.user_id
            AND u.source_type = 'civic_promise')
        OR (SELECT count(*) FROM public.unit_occurrences o
          WHERE o.unit_id = result.unit_id AND o.user_id = q.user_id
            AND o.scout_type = 'civic'
            AND (o.source_kind = 'civic_promise' OR o.metadata->>'civic_kind' = 'promise'))
          > CASE WHEN result.occurrence_created THEN 1 ELSE 0 END
      ) THEN
        RAISE EXCEPTION 'Existing Civic canonical item needs an explicit tracker repair';
      END IF;
      INSERT INTO public.promises(unit_id, user_id, scout_id, promise_text, context,
        source_url, source_title, meeting_date, due_date, date_confidence, status)
      VALUES(result.unit_id, q.user_id, q.scout_id, p_input->>'p_statement',
        p_input->>'p_context_excerpt', q.source_url, p_input->>'p_source_title',
        (p_input->>'p_occurred_at')::date, (meta->>'due_date')::date,
        meta->>'date_confidence', 'new') RETURNING * INTO tracker;
      INSERT INTO public.promise_revisions(promise_id, user_id, due_date, date_confidence,
        due_date_text, source_url, context, amendment_reason)
      VALUES(tracker.id, q.user_id, (meta->>'due_date')::date, meta->>'date_confidence',
        meta->>'due_date_text', q.source_url, COALESCE(p_input->>'p_context_excerpt',''), 'initial')
      RETURNING id INTO revision_id;
      UPDATE public.promises SET active_revision_id = revision_id
       WHERE id = tracker.id AND user_id = q.user_id;
    END IF;
    IF result.created_canonical AND q.ingestion_mode = 'scheduled' AND q.scout_run_id IS NOT NULL THEN
      INSERT INTO public.civic_run_alert_items(scout_run_id, queue_id, user_id, unit_id,
        statement, source_url, source_title)
      VALUES(q.scout_run_id, q.id, q.user_id, result.unit_id, p_input->>'p_statement',
        q.source_url, p_input->>'p_source_title');
    END IF;
  END IF;
  IF q.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Civic queue lease expired during item persistence';
  END IF;
  INSERT INTO public.civic_queue_item_results VALUES(q.id, p_input->>'p_statement_hash',
    q.user_id, result.unit_id, identity, result.created_canonical, result.merged_existing,
    result.occurrence_created, result.match_scope);
  RETURN QUERY SELECT result.unit_id::uuid, result.created_canonical::boolean,
    result.merged_existing::boolean, result.match_scope::text, result.occurrence_created::boolean;
END;
$$;
REVOKE ALL ON FUNCTION public.persist_civic_item(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_civic_item(uuid, text, jsonb) TO service_role;
