-- scrape_host_policy_timeouts
-- Host memory now learns from timeouts as well as anti-bot blocks: a primary
-- renderer that timed out and was rescued by Firecrawl is the same signal as
-- one that was blocked. Two rescues within seven days switch the host to
-- Firecrawl for fourteen days (was three). Clearing on a crawl4ai success is
-- unchanged. Operator decision 2026-09-22.

ALTER TABLE public.scrape_host_policy
  DROP CONSTRAINT IF EXISTS scrape_host_policy_reason_check;
ALTER TABLE public.scrape_host_policy
  ADD CONSTRAINT scrape_host_policy_reason_check
  CHECK (reason IN ('anti_bot', 'timeout'));

CREATE OR REPLACE FUNCTION public.record_scrape_host_block(p_host text, p_reason text DEFAULT 'anti_bot')
RETURNS public.scrape_host_policy
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c_evidence_window constant interval := interval '7 days';
  c_threshold constant int := 2;
  c_block_ttl constant interval := interval '14 days';
  v_row public.scrape_host_policy%ROWTYPE;
BEGIN
  IF p_host !~ '^[a-z0-9.-]{1,253}$' THEN
    RAISE EXCEPTION 'invalid scrape host';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('anti_bot', 'timeout') THEN
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
