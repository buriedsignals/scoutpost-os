-- Run discovery and document workers may overlap. Only a fully dispatched,
-- settled run seals an alert; existing initial/backfill queues stay compatible.
ALTER TABLE public.scout_runs ADD COLUMN civic_dispatch_complete boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.finalize_civic_run_doc(
  p_queue_id uuid,
  p_worker_id text,
  p_run_id uuid,
  p_created int,
  p_merged int,
  p_raw_capture_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows int;
  v_open int;
  v_failed int;
  v_queue_run_id uuid;
  v_queue_user_id uuid;
  v_queue_scout_id uuid;
BEGIN
  -- Lock and derive all tenancy/run identifiers from the queue row. The worker
  -- receives p_run_id only as an integrity assertion, never as authority to
  -- settle an unrelated run.
  SELECT scout_run_id, user_id, scout_id
    INTO v_queue_run_id, v_queue_user_id, v_queue_scout_id
    FROM public.civic_extraction_queue
   WHERE id = p_queue_id AND status = 'processing' AND lease_owner = p_worker_id
     AND lease_expires_at > now()
   FOR UPDATE;
  IF NOT FOUND OR p_run_id IS DISTINCT FROM v_queue_run_id THEN RETURN false; END IF;
  IF v_queue_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.scout_runs r
     WHERE r.id = v_queue_run_id AND r.user_id = v_queue_user_id
       AND r.scout_id = v_queue_scout_id
  ) THEN RETURN false; END IF;

  -- Serialize sibling completion before counting open documents.
  PERFORM 1 FROM public.scout_runs WHERE id = v_queue_run_id FOR UPDATE;

  UPDATE public.civic_extraction_queue
     SET status = 'done', raw_capture_id = COALESCE(p_raw_capture_id, raw_capture_id),
         lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
         completed_at = now(), updated_at = now()
   WHERE id = p_queue_id AND status = 'processing' AND lease_owner = p_worker_id
     AND lease_expires_at > now();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RETURN false; END IF;
  IF v_queue_run_id IS NULL THEN RETURN true; END IF;

  SELECT count(*) FILTER (WHERE status IN ('pending', 'processing')),
         count(*) FILTER (WHERE status = 'failed')
    INTO v_open, v_failed
    FROM public.civic_extraction_queue WHERE scout_run_id = v_queue_run_id;
  IF EXISTS (SELECT 1 FROM public.scout_runs
             WHERE id = v_queue_run_id AND NOT civic_dispatch_complete) THEN
    v_open := v_open + 1;
  END IF;
  UPDATE public.scout_runs
     SET units_created_count = COALESCE(units_created_count, 0) + COALESCE(p_created, 0),
         units_merged_count = COALESCE(units_merged_count, 0) + COALESCE(p_merged, 0),
         articles_count = COALESCE(articles_count, 0) + COALESCE(p_created, 0),
         merged_existing_count = COALESCE(merged_existing_count, 0) + COALESCE(p_merged, 0),
         criteria_status = COALESCE(criteria_status, false) OR (p_created > 0),
         status = CASE WHEN v_open = 0 AND v_failed > 0 THEN 'error'
                       WHEN v_open = 0 THEN 'success' ELSE status END,
         stage = CASE WHEN v_open = 0 THEN 'finalize' ELSE stage END,
         scraper_status = CASE WHEN v_open = 0 AND v_failed = 0 THEN true ELSE scraper_status END,
         notification_status = CASE WHEN v_open = 0 AND v_failed > 0 THEN 'not_applicable'
                                    WHEN v_open = 0 AND NOT EXISTS (SELECT 1 FROM public.civic_run_alert_items i WHERE i.scout_run_id = v_queue_run_id) THEN 'skipped'
                                    WHEN v_open = 0 THEN 'pending' ELSE notification_status END,
         completed_at = CASE WHEN v_open = 0 THEN now() ELSE completed_at END
   WHERE id = v_queue_run_id AND user_id = v_queue_user_id AND scout_id = v_queue_scout_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_civic_run_doc(uuid, text, uuid, int, int, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_civic_run_doc(uuid, text, uuid, int, int, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_civic_dispatch(p_run_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_open int; v_failed int;
BEGIN
  PERFORM 1 FROM public.scout_runs WHERE id = p_run_id FOR UPDATE;
  SELECT count(*) FILTER (WHERE status IN ('pending', 'processing')),
         count(*) FILTER (WHERE status = 'failed') INTO v_open, v_failed
    FROM public.civic_extraction_queue WHERE scout_run_id = p_run_id;
  UPDATE public.scout_runs SET civic_dispatch_complete = true,
    status = CASE WHEN v_open > 0 THEN status WHEN v_failed > 0 THEN 'error' ELSE 'success' END,
    stage = CASE WHEN v_open = 0 THEN 'finalize' ELSE stage END,
    completed_at = CASE WHEN v_open = 0 THEN now() ELSE completed_at END,
    notification_status = CASE WHEN v_open > 0 THEN notification_status
      WHEN v_failed > 0 THEN 'not_applicable'
      WHEN EXISTS (SELECT 1 FROM public.civic_run_alert_items i WHERE i.scout_run_id = p_run_id) THEN 'pending'
      ELSE 'skipped' END
    WHERE id = p_run_id;
END;
$$;
REVOKE ALL ON FUNCTION public.complete_civic_dispatch(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_civic_dispatch(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_civic_run_alert_delivery(
  p_run_id uuid, p_worker_id text, p_lease_seconds int DEFAULT 900
) RETURNS TABLE (
  delivery_id uuid, user_id uuid, provider_idempotency_key text,
  fencing_token bigint, needs_provider_submission boolean
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v public.civic_run_alert_deliveries%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.civic_run_alert_deliveries
   WHERE scout_run_id = p_run_id
     AND (state IN ('pending', 'failed') OR (state = 'sending' AND lease_expires_at < now())
          OR state = 'provider_accepted')
   FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.civic_run_alert_deliveries AS d
     SET state = CASE WHEN v.provider_accepted_at IS NOT NULL THEN 'provider_accepted' ELSE 'sending' END, lease_owner = p_worker_id,
         lease_expires_at = now() + make_interval(secs => greatest(1, p_lease_seconds)),
         fencing_token = v.fencing_token + 1, updated_at = now()
   WHERE d.id = v.id
   RETURNING d.id, d.user_id, d.provider_idempotency_key,
             d.fencing_token, (v.provider_accepted_at IS NULL)
   INTO delivery_id, user_id, provider_idempotency_key, fencing_token, needs_provider_submission;
  RETURN NEXT;
END;
$$;


-- Consume items in the same fenced transaction as the delivery. Reconciliation
-- must not leave pending items behind or turn accepted delivery into resubmission.
CREATE OR REPLACE FUNCTION public.finalize_civic_run_alert_delivery(
  p_delivery_id uuid, p_worker_id text, p_fencing_token bigint,
  p_state text, p_error text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run_id uuid;
BEGIN
  IF p_state NOT IN ('sent', 'failed') THEN RAISE EXCEPTION 'invalid alert final state'; END IF;
  UPDATE public.civic_run_alert_deliveries SET state = p_state, last_error = p_error,
    sent_at = CASE WHEN p_state = 'sent' THEN now() ELSE sent_at END,
    lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE id = p_delivery_id AND state IN ('sending', 'provider_accepted')
      AND lease_owner = p_worker_id AND fencing_token = p_fencing_token
    RETURNING scout_run_id INTO v_run_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_state = 'sent' THEN
    UPDATE public.civic_run_alert_items SET delivered_at = now()
      WHERE scout_run_id = v_run_id AND delivered_at IS NULL;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_due_promise_reminders(
  p_worker_id text,
  p_due_on_or_before date,
  p_limit int DEFAULT 100,
  p_lease_seconds int DEFAULT 900
)
RETURNS TABLE (
  delivery_id uuid,
  promise_id uuid,
  user_id uuid,
  promise_text text,
  source_url text,
  source_title text,
  due_date date,
  provider_idempotency_key text,
  needs_provider_submission boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(500, GREATEST(1, COALESCE(p_limit, 100)));
  v_lease int := LEAST(3600, GREATEST(60, COALESCE(p_lease_seconds, 900)));
BEGIN
  IF length(trim(COALESCE(p_worker_id, ''))) = 0 THEN
    RAISE EXCEPTION 'worker id is required';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT p.id, p.user_id, p.promise_text, p.source_url, p.source_title, p.due_date
      FROM public.promises p
     WHERE p.due_date IS NOT NULL
       AND p.due_date <= p_due_on_or_before
       AND p.status IN ('new', 'in_progress')
       AND p.due_notified_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.user_preferences pref
         WHERE pref.user_id = p.user_id AND pref.preferences->>'email_notifications' = 'false')
       AND (p.unit_id IS NULL OR EXISTS (SELECT 1 FROM public.information_units u
         WHERE u.id = p.unit_id AND u.user_id = p.user_id AND u.deleted_at IS NULL))
       AND NOT EXISTS (SELECT 1 FROM public.promise_reminder_deliveries d
         WHERE d.promise_id = p.id AND d.due_date = p.due_date
           AND (d.state = 'sent' OR (d.state = 'sending' AND d.lease_expires_at > now())))
     ORDER BY p.due_date, p.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT v_limit
  ), deliveries AS (
    INSERT INTO public.promise_reminder_deliveries AS delivery (
      user_id, promise_id, due_date, provider_idempotency_key, state,
      lease_owner, lease_expires_at, updated_at
    )
    SELECT c.user_id, c.id, c.due_date,
           'civic/reminder/' || c.user_id::text || '/' || c.id::text || '/' || c.due_date::text,
           'sending', p_worker_id, now() + make_interval(secs => v_lease), now()
      FROM candidates c
    ON CONFLICT ON CONSTRAINT promise_reminder_deliveries_user_id_promise_id_due_date_key DO UPDATE
      SET state = 'sending', lease_owner = p_worker_id,
          lease_expires_at = now() + make_interval(secs => v_lease),
          updated_at = now(), last_error = NULL
      WHERE delivery.state IN ('pending', 'failed')
         OR (delivery.state = 'sending'
             AND delivery.lease_expires_at <= now())
    RETURNING delivery.id, delivery.promise_id, delivery.user_id,
              delivery.due_date, delivery.provider_idempotency_key, true AS needs_provider_submission
  ), accepted AS (
    UPDATE public.promise_reminder_deliveries d
       SET lease_owner = p_worker_id,
           lease_expires_at = now() + make_interval(secs => v_lease),
           updated_at = now()
      FROM candidates c
     WHERE c.id = d.promise_id AND c.due_date = d.due_date AND d.state = 'provider_accepted'
     RETURNING d.id, d.promise_id, d.user_id, d.due_date,
               d.provider_idempotency_key, false AS needs_provider_submission
  )
  SELECT d.id, c.id, c.user_id, c.promise_text, c.source_url, c.source_title,
         d.due_date, d.provider_idempotency_key, d.needs_provider_submission
    FROM (SELECT * FROM deliveries UNION ALL SELECT * FROM accepted) d
    JOIN candidates c ON c.id = d.promise_id;
END;
$$;


-- A first verified Civic tracker is new even when dedup promotes an earlier
-- Page/Beat fact. Existing trackers and queue retries never create new alerts.
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
  created_tracker boolean := false;
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
      created_tracker := true;
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
    IF created_tracker AND q.ingestion_mode IN ('initial', 'scheduled') AND q.scout_run_id IS NOT NULL THEN
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

CREATE OR REPLACE FUNCTION public.seal_civic_run_alert_delivery()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'success' AND OLD.status IS DISTINCT FROM 'success'
    AND EXISTS (SELECT 1 FROM public.civic_extraction_queue q
      WHERE q.scout_run_id = NEW.id AND q.ingestion_mode IN ('initial', 'scheduled'))
    AND EXISTS (SELECT 1 FROM public.civic_run_alert_items i WHERE i.scout_run_id = NEW.id)
  THEN
    INSERT INTO public.civic_run_alert_deliveries(scout_run_id,user_id,provider_idempotency_key)
      VALUES(NEW.id,NEW.user_id,'civic/' || NEW.id::text || '/new-items')
      ON CONFLICT(scout_run_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- The ordinary first import is a real run, not a preview email. Claim the
-- snapshot, create its run, and enqueue all documents in one transaction.
CREATE FUNCTION public.enqueue_initial_civic_run(
  p_scout_id uuid, p_user_id uuid, p_snapshot_id uuid, p_source_urls text[]
) RETURNS int LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE snapshot public.civic_preview_snapshots%ROWTYPE; run_id uuid; queued int;
BEGIN
  PERFORM 1 FROM public.scouts WHERE id=p_scout_id AND user_id=p_user_id AND type='civic' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Civic scout not found'; END IF;
  SELECT * INTO snapshot FROM public.civic_preview_snapshots
    WHERE id=p_snapshot_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR snapshot.expires_at<=now() OR snapshot.policy_version<>'civic-accountability-v2' THEN
    RAISE EXCEPTION 'Civic preview expired or incompatible';
  END IF;
  IF snapshot.consumed_by_scout_id IS NOT NULL THEN
    IF snapshot.consumed_by_scout_id=p_scout_id THEN
      SELECT id INTO run_id FROM public.scout_runs WHERE scout_id=p_scout_id AND user_id=p_user_id
        AND metadata->>'preview_snapshot_id'=p_snapshot_id::text;
      IF FOUND THEN
        SELECT count(*)::int INTO queued FROM public.civic_extraction_queue WHERE scout_run_id=run_id;
        RETURN queued;
      END IF;
    END IF;
    RAISE EXCEPTION 'Civic preview has already been used';
  END IF;
  IF COALESCE(cardinality(p_source_urls),0)=0 THEN RETURN 0; END IF;
  INSERT INTO public.scout_runs(scout_id,user_id,status,civic_dispatch_complete,metadata)
    VALUES(p_scout_id,p_user_id,'running',true,jsonb_build_object(
      'ingestion_mode','initial','preview_snapshot_id',p_snapshot_id)) RETURNING id INTO run_id;
  UPDATE public.civic_preview_snapshots SET consumed_by_scout_id=p_scout_id WHERE id=p_snapshot_id;
  INSERT INTO public.civic_extraction_queue(scout_id,user_id,scout_run_id,source_url,doc_kind,
    ingestion_mode,civic_policy_version,preview_snapshot_id,semantics_snapshot)
    SELECT p_scout_id,p_user_id,run_id,url,
      CASE WHEN url ~* '\.pdf($|[?#])' THEN 'pdf' ELSE 'html' END,
      'initial','civic-accountability-v2',p_snapshot_id,
      jsonb_build_object('criteria',snapshot.criteria,'preview_snapshot_id',p_snapshot_id)
      FROM (SELECT DISTINCT unnest(p_source_urls) AS url) sources;
  GET DIAGNOSTICS queued = ROW_COUNT;
  RETURN queued;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_initial_civic_run(uuid,uuid,uuid,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_initial_civic_run(uuid,uuid,uuid,text[]) TO service_role;
