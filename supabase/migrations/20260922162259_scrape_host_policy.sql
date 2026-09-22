-- scrape_host_policy
-- Remember hosts whose anti-bot protection always blocks the primary renderer
-- (crawl4ai) so the scrape port and the durable Page crawler route straight to
-- Firecrawl instead of paying for a doomed first attempt. Evidence: three
-- crawl4ai anti-bot blocks rescued by Firecrawl within seven days; the block
-- expires after fourteen days and is cleared by any crawl4ai success.
-- Plan U4: docs/plans/2026-09-22-1620-feat-crawler-scheduling-resilience-plan.md

CREATE TABLE public.scrape_host_policy (
  host text PRIMARY KEY CHECK (host ~ '^[a-z0-9.-]{1,253}$'),
  primary_provider text NOT NULL DEFAULT 'firecrawl'
    CHECK (primary_provider IN ('firecrawl')),
  reason text NOT NULL CHECK (reason IN ('anti_bot')),
  evidence_count int NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.scrape_host_policy IS
  'Service-only memory of hosts where the primary renderer is blocked; expires_at NULL means evidence only, not yet enforced.';
ALTER TABLE public.scrape_host_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scrape_host_policy FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scrape_host_policy TO service_role;

CREATE FUNCTION public.record_scrape_host_block(p_host text, p_reason text DEFAULT 'anti_bot')
RETURNS public.scrape_host_policy
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c_evidence_window constant interval := interval '7 days';
  c_threshold constant int := 3;
  c_block_ttl constant interval := interval '14 days';
  v_row public.scrape_host_policy%ROWTYPE;
BEGIN
  IF p_host !~ '^[a-z0-9.-]{1,253}$' THEN
    RAISE EXCEPTION 'invalid scrape host';
  END IF;
  IF p_reason IS DISTINCT FROM 'anti_bot' THEN
    RAISE EXCEPTION 'unsupported scrape host block reason';
  END IF;
  INSERT INTO public.scrape_host_policy (host, reason, evidence_count, first_seen_at, last_seen_at)
  VALUES (p_host, p_reason, 1, now(), now())
  ON CONFLICT (host) DO UPDATE
    SET evidence_count = CASE
          WHEN scrape_host_policy.last_seen_at > now() - c_evidence_window
            THEN scrape_host_policy.evidence_count + 1
          ELSE 1
        END,
        first_seen_at = CASE
          WHEN scrape_host_policy.last_seen_at > now() - c_evidence_window
            THEN scrape_host_policy.first_seen_at
          ELSE now()
        END,
        last_seen_at = now(),
        reason = EXCLUDED.reason,
        updated_at = now()
  RETURNING * INTO v_row;
  IF v_row.evidence_count >= c_threshold THEN
    UPDATE public.scrape_host_policy
       SET expires_at = now() + c_block_ttl, updated_at = now()
     WHERE host = p_host
    RETURNING * INTO v_row;
  END IF;
  RETURN v_row;
END;
$$;

CREATE FUNCTION public.clear_scrape_host_block(p_host text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.scrape_host_policy WHERE host = p_host;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.record_scrape_host_block(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_scrape_host_block(text, text) TO service_role;
REVOKE ALL ON FUNCTION public.clear_scrape_host_block(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_scrape_host_block(text) TO service_role;

-- Durable Page jobs for a blocked host skip the worker entirely: they are
-- inserted already in fallback_required with the same bookkeeping the worker
-- writes for an anti-bot block, so claim_page_crawler_fallback and the health
-- exclusions treat them exactly like a worker-reported block.
DROP FUNCTION public.enqueue_crawler_job(text, text, text, text, text, text, text, jsonb, int, int, uuid, uuid, uuid);
CREATE FUNCTION public.enqueue_crawler_job(
  p_dedupe_key text,
  p_request_kind text,
  p_tenant_key text,
  p_continuation_key text,
  p_operation text,
  p_pipeline_stage text,
  p_url text,
  p_options jsonb DEFAULT '{}'::jsonb,
  p_priority int DEFAULT 0,
  p_max_attempts int DEFAULT 3,
  p_scout_run_id uuid DEFAULT NULL,
  p_scout_id uuid DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_fallback_reason text DEFAULT NULL
) RETURNS public.crawler_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.crawler_jobs%ROWTYPE;
BEGIN
  IF length(trim(COALESCE(p_dedupe_key, ''))) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid crawler dedupe key';
  END IF;
  IF p_fallback_reason IS NOT NULL
     AND (p_fallback_reason <> 'anti_bot' OR p_operation <> 'scrape') THEN
    RAISE EXCEPTION 'invalid crawler fallback routing';
  END IF;
  INSERT INTO public.crawler_jobs (
    dedupe_key, request_kind, tenant_key, continuation_key,
    operation, pipeline_stage, url, options, priority, max_attempts,
    scout_run_id, scout_id, user_id,
    status, error_class, error_message, completed_at
  ) VALUES (
    p_dedupe_key, p_request_kind, p_tenant_key, p_continuation_key,
    p_operation, p_pipeline_stage, p_url, COALESCE(p_options, '{}'::jsonb),
    LEAST(1000, GREATEST(-1000, COALESCE(p_priority, 0))),
    LEAST(10, GREATEST(1, COALESCE(p_max_attempts, 3))),
    p_scout_run_id, p_scout_id, p_user_id,
    CASE WHEN p_fallback_reason IS NULL THEN 'queued' ELSE 'fallback_required' END,
    CASE WHEN p_fallback_reason IS NULL THEN NULL ELSE 'anti_bot' END,
    CASE WHEN p_fallback_reason IS NULL THEN NULL
         ELSE 'host policy: primary renderer blocked by anti-bot protection' END,
    CASE WHEN p_fallback_reason IS NULL THEN NULL ELSE now() END
  )
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING * INTO v_job;
  IF v_job.id IS NULL THEN
    SELECT * INTO STRICT v_job
      FROM public.crawler_jobs
     WHERE dedupe_key = p_dedupe_key;
  END IF;
  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_crawler_job(text, text, text, text, text, text, text, jsonb, int, int, uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_crawler_job(text, text, text, text, text, text, text, jsonb, int, int, uuid, uuid, uuid, text)
  TO service_role;

-- Operators see how many hosts are currently routed away from the primary
-- renderer, so a provider-wide problem is not mistaken for many host blocks.
CREATE OR REPLACE FUNCTION public.crawler_operations_observation()
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
    'blocked_hosts', (SELECT count(*) FROM public.scrape_host_policy WHERE expires_at > now()),
    'retrieval_groups', COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM groups g), '[]'::jsonb)
  ) FROM public.crawler_operations_health() h;
$$;
