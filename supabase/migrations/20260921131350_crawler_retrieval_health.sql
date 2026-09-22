-- Additive monitor contract. Keep crawler_operations_health() for old callers.
BEGIN;

CREATE FUNCTION public.crawler_retrieval_failure_category(p_class text, p_message text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN p_class = 'fallback_terminal'
      AND p_message = 'crawler proxy caller no longer waiting' THEN 'caller_abandoned'
    WHEN (p_class = 'timeout' AND (
      p_message = 'crawl timed out'
      OR p_message ~ '^Page.goto: Timeout [0-9]+ms exceeded'
    )) OR (p_class = 'fallback_terminal'
      AND p_message LIKE 'firecrawl scrape failed: 408 %'
      AND p_message ~ '"code"[[:space:]]*:[[:space:]]*"SCRAPE_TIMEOUT"') THEN 'retrieval_timeout'
    WHEN p_class IN ('retryable', 'terminal', 'anti_bot', 'timeout')
      AND p_message ~ '^Page.goto: net::ERR_(HTTP2_PROTOCOL_ERROR|HTTP_RESPONSE_CODE_FAILURE|EMPTY_RESPONSE|TIMED_OUT)( |$)'
      THEN 'target_navigation'
    ELSE NULL -- Unknown, auth, callbacks, storage and task errors stay on the workflow path.
  END;
$$;
REVOKE ALL ON FUNCTION public.crawler_retrieval_failure_category(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crawler_retrieval_failure_category(text, text) TO service_role;

CREATE FUNCTION public.crawler_operations_observation()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH recent AS MATERIALIZED (
    SELECT operation, completed_at, url,
      public.crawler_retrieval_failure_category(error_class, error_message) AS category
    FROM public.crawler_jobs
    WHERE status = 'terminal_failed' AND completed_at > now() - interval '1 hour'
      -- Preserve established exclusions, but never silently drop a NULL/unknown error.
      AND NOT COALESCE(error_class = 'fallback_terminal' AND error_message IN (
        'anti-bot fallback delegated to scrape caller', 'timeout-exhausted fallback delegated to scrape caller'
      ), false)
      AND NOT COALESCE(error_class = 'terminal' AND error_message LIKE 'download failed: cannot resolve %', false)
      AND NOT COALESCE(operation = 'parse_pdf' AND error_class = 'terminal' AND error_message = 'not_a_pdf', false)
  ), groups AS (
    SELECT category, operation,
      -- Host only: no credentials, paths, queries, response bodies or customer content.
      COALESCE(left(lower(substring(url FROM '^https?://(?:[^/@]*@)?([A-Za-z0-9.-]+)(?::[0-9]+)?(?:[/?#]|$)')), 253), 'unknown') AS hostname,
      count(*) AS jobs, max(completed_at) AS latest_terminal_at
    FROM recent WHERE category IS NOT NULL GROUP BY 1, 2, 3
    ORDER BY jobs DESC, category, operation, hostname LIMIT 10
  )
  SELECT to_jsonb(h) || jsonb_build_object(
    'schema_version', 1,
    'observed_at', now(),
    'window_seconds', 3600,
    'batched_waiting', (SELECT count(*) FROM public.crawler_jobs WHERE status = 'batched'),
    'terminal_failed_recent', (SELECT count(*) FROM recent),
    'workflow_failed_recent', (SELECT count(*) FROM recent WHERE category IS NULL),
    'retrieval_failed_recent', (SELECT count(*) FROM recent WHERE category IS NOT NULL),
    'caller_abandoned_recent', (SELECT count(*) FROM recent WHERE category = 'caller_abandoned'),
    'retrieval_groups', COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM groups g), '[]'::jsonb)
  ) FROM public.crawler_operations_health() h;
$$;
REVOKE ALL ON FUNCTION public.crawler_operations_observation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crawler_operations_observation() TO service_role;

ALTER TABLE public.operator_incidents
  DROP CONSTRAINT operator_incidents_kind_check;
ALTER TABLE public.operator_incidents
  ADD CONSTRAINT operator_incidents_kind_check CHECK (kind IN (
    'dispatch_queue_delay',
    'civic_queue_delay',
    'vessel_sampler_health',
    'crawler_workflow_health',
    'crawler_retrieval_failures',
    'celestrak_gp_provider_health'
  ));

CREATE OR REPLACE FUNCTION public.record_operator_incident(
  p_incident_key text,
  p_kind text,
  p_active boolean,
  p_severity text,
  p_summary text,
  p_details jsonb DEFAULT '{}'::jsonb,
  p_repeat_seconds int DEFAULT 21600
)
RETURNS TABLE (should_notify boolean, transition text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.operator_incidents%ROWTYPE;
  v_now timestamptz := now();
  v_repeat int := LEAST(86400, GREATEST(300, COALESCE(p_repeat_seconds, 21600)));
BEGIN
  IF length(trim(COALESCE(p_incident_key, ''))) = 0 THEN
    RAISE EXCEPTION 'incident key is required';
  END IF;
  IF p_kind NOT IN (
    'dispatch_queue_delay',
    'civic_queue_delay',
    'vessel_sampler_health',
    'crawler_workflow_health',
    'crawler_retrieval_failures',
    'celestrak_gp_provider_health'
  ) THEN
    RAISE EXCEPTION 'invalid incident kind';
  END IF;
  IF p_severity NOT IN ('warning', 'critical') THEN
    RAISE EXCEPTION 'invalid incident severity';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('operator:' || p_incident_key, 0));
  SELECT * INTO v_existing
    FROM public.operator_incidents
   WHERE incident_key = p_incident_key
   FOR UPDATE;

  IF p_active THEN
    should_notify := NOT FOUND
      OR v_existing.status = 'resolved'
      OR v_existing.notification_pending
      -- Newly split crawler incidents must notify on escalation inside cooldown.
      OR (p_kind IN ('crawler_workflow_health', 'crawler_retrieval_failures')
        AND v_existing.severity = 'warning' AND p_severity = 'critical')
      OR v_existing.last_notified_at IS NULL
      OR v_existing.last_notified_at <= v_now - make_interval(secs => v_repeat);
    transition := CASE
      WHEN NOT FOUND OR v_existing.status = 'resolved' THEN 'opened'
      WHEN should_notify THEN 'reminder'
      ELSE 'unchanged'
    END;

    INSERT INTO public.operator_incidents (
      incident_key, kind, status, severity, summary, details,
      first_observed_at, last_observed_at, last_notified_at,
      notification_pending, resolved_at, updated_at
    ) VALUES (
      p_incident_key, p_kind, 'active', p_severity,
      left(p_summary, 1000), COALESCE(p_details, '{}'::jsonb),
      v_now, v_now, NULL, should_notify, NULL, v_now
    )
    ON CONFLICT (incident_key) DO UPDATE
      SET kind = EXCLUDED.kind,
          status = 'active',
          severity = EXCLUDED.severity,
          summary = EXCLUDED.summary,
          details = EXCLUDED.details,
          first_observed_at = CASE
            WHEN public.operator_incidents.status = 'resolved' THEN v_now
            ELSE public.operator_incidents.first_observed_at
          END,
          last_observed_at = v_now,
          notification_pending = public.operator_incidents.notification_pending
            OR should_notify,
          resolved_at = NULL,
          updated_at = v_now;
    RETURN NEXT;
    RETURN;
  END IF;

  IF NOT FOUND THEN
    should_notify := false;
    transition := 'unchanged';
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_existing.status = 'resolved' THEN
    should_notify := v_existing.notification_pending;
    transition := CASE WHEN should_notify THEN 'resolved' ELSE 'unchanged' END;
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE public.operator_incidents
     SET status = 'resolved',
         summary = left(p_summary, 1000),
         details = COALESCE(p_details, '{}'::jsonb),
         last_observed_at = v_now,
         notification_pending = true,
         resolved_at = v_now,
         updated_at = v_now
   WHERE incident_key = p_incident_key;
  should_notify := true;
  transition := 'resolved';
  RETURN NEXT;
END;
$$;

COMMIT;
