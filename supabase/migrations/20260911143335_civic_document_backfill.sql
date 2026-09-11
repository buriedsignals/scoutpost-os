-- Explicit historical imports keep their reviewed text and never advance live baselines.
ALTER TABLE public.civic_extraction_queue DROP CONSTRAINT civic_extraction_queue_ingestion_mode_check;
ALTER TABLE public.civic_extraction_queue ADD CONSTRAINT civic_extraction_queue_ingestion_mode_check
 CHECK (ingestion_mode IN ('initial','scheduled','repair','backfill'));
CREATE UNIQUE INDEX civic_backfill_document_identity ON public.civic_extraction_queue
 (scout_id, source_url, (semantics_snapshot->>'content_sha256')) WHERE ingestion_mode='backfill';

CREATE FUNCTION public.guard_civic_backfill_queue() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
 -- All enqueue paths serialize on the Scout, including the normal scheduler.
 PERFORM 1 FROM public.scouts WHERE id=NEW.scout_id FOR UPDATE;
 IF EXISTS (SELECT 1 FROM public.civic_extraction_queue q WHERE q.scout_id=NEW.scout_id
   AND q.status IN ('pending','processing') AND q.scout_run_id IS DISTINCT FROM NEW.scout_run_id
   AND (q.ingestion_mode='backfill' OR NEW.ingestion_mode='backfill')) THEN
   RAISE EXCEPTION 'Civic Scout has other active queue work';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER civic_backfill_queue_guard BEFORE INSERT ON public.civic_extraction_queue
 FOR EACH ROW EXECUTE FUNCTION public.guard_civic_backfill_queue();
REVOKE ALL ON FUNCTION public.guard_civic_backfill_queue() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guard_civic_backfill_queue() TO service_role;

CREATE FUNCTION public.suppress_civic_backfill_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
 IF NEW.metadata->>'ingestion_mode'='backfill' THEN NEW.notification_status:='not_applicable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER civic_backfill_no_notification BEFORE INSERT OR UPDATE ON public.scout_runs
 FOR EACH ROW EXECUTE FUNCTION public.suppress_civic_backfill_notification();
REVOKE ALL ON FUNCTION public.suppress_civic_backfill_notification() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.suppress_civic_backfill_notification() TO service_role;

CREATE FUNCTION public.enqueue_civic_backfill(p_run_id uuid,p_user_id uuid,p_scout_id uuid,
 p_manifest_hash text,p_scout_snapshot jsonb,p_documents jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,extensions AS $$
DECLARE s public.scouts%ROWTYPE; r public.scout_runs%ROWTYPE; d jsonb; capture_id uuid;
 snapshot jsonb; request_identity jsonb;
BEGIN
 IF p_run_id IS NULL OR p_manifest_hash IS NULL OR p_manifest_hash !~ '^[0-9a-f]{64}$'
   OR jsonb_typeof(p_documents) IS DISTINCT FROM 'array'
   OR jsonb_array_length(p_documents) NOT BETWEEN 1 AND 10 THEN
   RAISE EXCEPTION 'Backfill requires a run id, SHA256 manifest and 1-10 documents';
 END IF;
 SELECT * INTO s FROM public.scouts WHERE id=p_scout_id FOR UPDATE;
 IF NOT FOUND OR s.user_id IS DISTINCT FROM p_user_id OR s.type<>'civic' THEN
   RAISE EXCEPTION 'Backfill Scout ownership/type mismatch';
 END IF;
 request_identity:=jsonb_build_object('scout_snapshot',p_scout_snapshot,'documents',
   (SELECT jsonb_agg(value-'markdown') FROM jsonb_array_elements(p_documents)));
 FOR d IN SELECT value FROM jsonb_array_elements(p_documents) LOOP
   IF jsonb_typeof(d->'markdown') IS DISTINCT FROM 'string'
     OR encode(extensions.digest(convert_to(d->>'markdown','UTF8'),'sha256'),'hex') IS DISTINCT FROM d->>'content_sha256' THEN
     RAISE EXCEPTION 'Backfill parsed text hash mismatch';
   END IF;
 END LOOP;
 SELECT * INTO r FROM public.scout_runs WHERE id=p_run_id;
 IF FOUND THEN
   IF r.user_id IS DISTINCT FROM p_user_id OR r.scout_id IS DISTINCT FROM p_scout_id
     OR r.metadata->>'ingestion_mode' IS DISTINCT FROM 'backfill'
     OR r.metadata->>'manifest_hash' IS DISTINCT FROM p_manifest_hash
     OR r.metadata->'backfill_request' IS DISTINCT FROM request_identity THEN
     RAISE EXCEPTION 'Backfill run identity mismatch';
   END IF;
   RETURN p_run_id;
 END IF;
 snapshot:=jsonb_build_object('tracked_urls',s.tracked_urls,'criteria',s.criteria,
   'preferred_language',s.preferred_language,'project_id',s.project_id);
 IF s.is_active IS DISTINCT FROM true OR snapshot IS DISTINCT FROM p_scout_snapshot THEN
   RAISE EXCEPTION 'Backfill Scout is paused or its reviewed configuration changed';
 END IF;
 IF EXISTS(SELECT 1 FROM public.civic_extraction_queue WHERE scout_id=s.id AND status IN ('pending','processing')) THEN
   RAISE EXCEPTION 'Civic Scout has other active queue work';
 END IF;
 -- Validate the entire batch before any write. Parsed text, not source bytes, is hashed.
 FOR d IN SELECT value FROM jsonb_array_elements(p_documents) LOOP
   IF jsonb_typeof(d) IS DISTINCT FROM 'object'
     OR COALESCE(d->>'source_url','') !~ '^https?://[^/[:space:]]+'
     OR NOT COALESCE(d->>'listing_url'=ANY(s.tracked_urls),false)
     OR COALESCE(d->>'doc_kind','') NOT IN ('pdf','html')
     OR COALESCE(d->>'document_date','') !~ '^\d{4}-\d{2}-\d{2}$'
     OR to_char((d->>'document_date')::date,'YYYY-MM-DD') IS DISTINCT FROM d->>'document_date'
     OR jsonb_typeof(d->'markdown') IS DISTINCT FROM 'string'
     OR length(btrim(d->>'markdown'))=0 OR length(d->>'markdown')>40000
     OR encode(extensions.digest(convert_to(d->>'markdown','UTF8'),'sha256'),'hex') IS DISTINCT FROM d->>'content_sha256'
     OR (d->>'source_content_sha256' IS NOT NULL AND d->>'source_content_sha256' !~ '^[0-9a-f]{64}$')
     OR (d->'source_characters' IS NOT NULL AND (d->>'source_characters')::bigint < length(d->>'markdown'))
     OR (d->'selection' IS NOT NULL AND d->'selection'<>'null'::jsonb AND (
       jsonb_typeof(d->'selection') IS DISTINCT FROM 'object'
       OR COALESCE((d->'selection'->>'start_character')::bigint,-1)<0
       OR COALESCE((d->'selection'->>'end_character')::bigint,0)<=COALESCE((d->'selection'->>'start_character')::bigint,0)
       OR (d->'selection'->>'end_character')::bigint-(d->'selection'->>'start_character')::bigint>40000
       OR (d->'selection'->>'end_character')::bigint>COALESCE((d->>'source_characters')::bigint,0)
       OR COALESCE(d->'selection'->>'label','')=''
       OR d->>'source_content_sha256' IS NULL))
     OR (d->'title' IS NOT NULL AND jsonb_typeof(d->'title') NOT IN ('string','null')) THEN
     RAISE EXCEPTION 'Invalid reviewed backfill document';
   END IF;
 END LOOP;
 INSERT INTO public.scout_runs(id,user_id,scout_id,status,stage,notification_status,metadata)
 VALUES(p_run_id,p_user_id,p_scout_id,'running','scrape','not_applicable',jsonb_build_object(
   'ingestion_mode','backfill','manifest_hash',p_manifest_hash,'backfill_request',request_identity,
   'selected_documents',jsonb_array_length(p_documents),'historical_notifications_suppressed',true));
 FOR d IN SELECT value FROM jsonb_array_elements(p_documents) LOOP
   INSERT INTO public.raw_captures(user_id,scout_id,scout_run_id,source_url,content_md,content_sha256,
      token_count,expires_at)
   VALUES(p_user_id,p_scout_id,p_run_id,d->>'source_url',d->>'markdown',d->>'content_sha256',
     ceil(length(d->>'markdown')/4.0),now()+interval '30 days') RETURNING id INTO capture_id;
   INSERT INTO public.civic_extraction_queue(user_id,scout_id,scout_run_id,source_url,doc_kind,
     ingestion_mode,civic_policy_version,raw_capture_id,semantics_snapshot)
   VALUES(p_user_id,p_scout_id,p_run_id,d->>'source_url',d->>'doc_kind','backfill','civic-accountability-v2',
     capture_id,jsonb_build_object('raw_capture_id',capture_id,'content_sha256',d->>'content_sha256',
       'scout_snapshot',snapshot,'document_date',d->>'document_date','listing_url',d->>'listing_url',
       'title',d->'title','parsed_text_length',length(d->>'markdown'),
       'selection',d->'selection','source_content_sha256',d->>'source_content_sha256',
       'source_characters',d->'source_characters'));
 END LOOP;
 RETURN p_run_id;
END $$;
REVOKE ALL ON FUNCTION public.enqueue_civic_backfill(uuid,uuid,uuid,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_civic_backfill(uuid,uuid,uuid,text,jsonb,jsonb) TO service_role;

-- Same atomic persistence; backfill never enters the scheduled alert branch.
CREATE OR REPLACE FUNCTION public.persist_civic_item(p_queue_id uuid, p_worker_id text, p_input jsonb)
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
  IF q.ingestion_mode NOT IN ('initial', 'scheduled', 'backfill') THEN
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
