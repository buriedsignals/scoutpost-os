BEGIN;

-- Internal Page run controls. Neither preview nor replay changes Scout schedules.
ALTER TABLE public.scout_runs
  ADD COLUMN page_notification_mode text
    CHECK (page_notification_mode IN ('deliver', 'disabled'));

CREATE FUNCTION public.bind_page_scout_notification_mode(
  p_run_id uuid, p_scout_id uuid, p_mode text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_mode text;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('deliver', 'disabled') THEN
    RAISE EXCEPTION 'invalid Page notification mode';
  END IF;
  SELECT r.page_notification_mode INTO v_mode
    FROM public.scout_runs r
    JOIN public.scouts s ON s.id = r.scout_id
   WHERE r.id = p_run_id AND r.scout_id = p_scout_id
     AND s.user_id = r.user_id AND s.type = 'web' AND r.status = 'running'
   FOR NO KEY UPDATE OF r;
  IF NOT FOUND THEN RAISE EXCEPTION 'Page run is missing or terminal'; END IF;
  IF v_mode IS NULL THEN
    UPDATE public.scout_runs SET page_notification_mode = p_mode
     WHERE id = p_run_id
    RETURNING page_notification_mode INTO v_mode;
  END IF;
  RETURN v_mode;
END;
$$;

CREATE FUNCTION public.prepare_page_scout_replay(
  p_scout_id uuid,
  p_run_id uuid,
  p_apply boolean DEFAULT false,
  p_expected_snapshot jsonb DEFAULT NULL,
  p_approved_credit_cost int DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_scout public.scouts%ROWTYPE;
  v_existing public.scout_runs%ROWTYPE;
  v_snapshot jsonb;
  v_captures jsonb;
BEGIN
  IF p_run_id IS NULL THEN RAISE EXCEPTION 'replay run ID is required'; END IF;
  IF p_apply IS NULL THEN RAISE EXCEPTION 'apply must be explicit'; END IF;
  IF p_apply THEN
    IF p_expected_snapshot IS NULL OR p_approved_credit_cost IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'replay requires its preview and explicit one-credit approval';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_scout_id::text, 0));
    SELECT * INTO v_existing FROM public.scout_runs WHERE id = p_run_id;
    IF FOUND THEN
      IF v_existing.scout_id <> p_scout_id
         OR v_existing.metadata->'operator_replay'->'snapshot' IS DISTINCT FROM p_expected_snapshot
         OR jsonb_typeof(v_existing.metadata->'operator_replay') IS DISTINCT FROM 'object'
         OR (v_existing.metadata->'operator_replay'->>'approved_credit_cost')::int
              IS DISTINCT FROM p_approved_credit_cost
         OR v_existing.page_notification_mode IS DISTINCT FROM 'disabled' THEN
        RAISE EXCEPTION 'replay ID is already used by a different operation';
      END IF;
      RETURN jsonb_build_object('run_id', p_run_id, 'scout_id', p_scout_id,
        'created', false, 'status', v_existing.status,
        'approved_credit_cost', v_existing.metadata->'operator_replay'->'approved_credit_cost');
    END IF;
  END IF;

  IF p_apply THEN
    SELECT * INTO v_scout FROM public.scouts WHERE id = p_scout_id FOR UPDATE;
  ELSE
    SELECT * INTO v_scout FROM public.scouts WHERE id = p_scout_id;
  END IF;
  IF NOT FOUND OR v_scout.type <> 'web' OR v_scout.url IS NULL THEN
    RAISE EXCEPTION 'replay requires an existing Page Scout with a URL';
  END IF;
  IF v_scout.is_active IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'operator replay requires a paused Scout';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.scout_dispatch_queue
     WHERE scout_id = p_scout_id AND status IN ('queued', 'leased', 'waiting')
  ) THEN
    RAISE EXCEPTION 'Scout already has a queued or executing run';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.captured_at DESC, c.id), '[]'::jsonb)
    INTO v_captures
    FROM (
      SELECT rc.id, rc.captured_at, rc.scout_run_id, r.status AS run_status,
             rc.page_validation_version, rc.page_validation_outcome,
             rc.content_sha256, rc.canonical_content_sha256, rc.canonicalizer_version,
             rc.comparison_strategy
        FROM public.raw_captures rc
        LEFT JOIN public.scout_runs r ON r.id = rc.scout_run_id
       WHERE rc.scout_id = p_scout_id AND rc.source_url = v_scout.url
         AND rc.canonical_content_sha256 IS NOT NULL
       ORDER BY rc.captured_at DESC, rc.id LIMIT 50
    ) c;
  v_snapshot := jsonb_build_object('scout', to_jsonb(v_scout), 'baseline_captures', v_captures);

  IF NOT p_apply THEN
    RETURN jsonb_build_object(
      'run_id', p_run_id, 'scout_id', p_scout_id, 'url', v_scout.url,
      'name', v_scout.name, 'user_id', v_scout.user_id,
      'snapshot', v_snapshot, 'maximum_credit_cost', 1,
      'notification_mode', 'disabled', 'crawler_backend', 'workflow',
      'writes', jsonb_build_array('scout run and dispatch job', 'normal captures, units and archive effects',
        'normal failure accounting and idempotent credit/refund records'),
      'schedule_changed', false
    );
  END IF;
  IF p_expected_snapshot IS NULL OR p_expected_snapshot IS DISTINCT FROM v_snapshot THEN
    RAISE EXCEPTION 'Scout or baseline changed since preview; preview again';
  END IF;
  -- The executor also checks its current code-owned credit cost against this
  -- approval before charging, so a later price change cannot exceed approval.
  IF p_approved_credit_cost IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'explicit approval for at most one Page-run credit is required';
  END IF;

  INSERT INTO public.scout_runs (
    id, scout_id, user_id, status, stage, started_at, crawler_backend,
    workflow_stage, page_notification_mode, metadata
  ) VALUES (
    p_run_id, p_scout_id, v_scout.user_id, 'running', 'queued', now(), 'workflow',
    'needs_root', 'disabled', jsonb_build_object(
      'dispatch_source', 'manual',
      'operator_replay', jsonb_build_object('snapshot', v_snapshot,
        'approved_credit_cost', p_approved_credit_cost, 'approved_at', now())
    )
  );
  INSERT INTO public.scout_dispatch_queue (
    scout_run_id, scout_id, user_id, scout_type, source, priority
  ) VALUES (p_run_id, p_scout_id, v_scout.user_id, 'web', 'manual', 100);
  RETURN jsonb_build_object('run_id', p_run_id, 'scout_id', p_scout_id,
    'created', true, 'status', 'running', 'approved_credit_cost', p_approved_credit_cost);
END;
$$;

REVOKE ALL ON FUNCTION public.bind_page_scout_notification_mode(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_page_scout_replay(uuid,uuid,boolean,jsonb,int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_page_scout_notification_mode(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_page_scout_replay(uuid,uuid,boolean,jsonb,int) TO service_role;

COMMIT;
