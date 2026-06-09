-- Persist actual AI provider usage metadata for operator cost reporting.
-- Rows are best-effort audit records written by Edge Functions after provider
-- responses include usage metadata. Do not backfill from raw_captures.token_count:
-- that column is only a rough content-size estimate, not provider billing data.

CREATE TABLE IF NOT EXISTS public.ai_usage_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  org_id UUID REFERENCES public.orgs(id) ON DELETE SET NULL,
  scout_id UUID,
  scout_run_id UUID REFERENCES public.scout_runs(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  operation TEXT NOT NULL,
  function_name TEXT,
  prompt_tokens INT NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens INT NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  total_tokens INT NOT NULL CHECK (total_tokens >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '180 days')
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_created
  ON public.ai_usage_records(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user_time
  ON public.ai_usage_records(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_usage_org_time
  ON public.ai_usage_records(org_id, created_at DESC)
  WHERE org_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_usage_run
  ON public.ai_usage_records(scout_run_id)
  WHERE scout_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_usage_expires
  ON public.ai_usage_records(expires_at);

ALTER TABLE public.ai_usage_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_usage_records_read ON public.ai_usage_records;
CREATE POLICY ai_usage_records_read
  ON public.ai_usage_records
  FOR SELECT
  USING (
    user_id = (SELECT auth.uid())
    OR org_id IN (
      SELECT org_id FROM public.org_members WHERE user_id = (SELECT auth.uid())
    )
  );

REVOKE INSERT, UPDATE, DELETE ON public.ai_usage_records FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.cleanup_ai_usage_records()
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count INT;
BEGIN
  DELETE FROM public.ai_usage_records WHERE id IN (
    SELECT id FROM public.ai_usage_records
    WHERE expires_at < now()
    LIMIT 10000
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_ai_usage_records() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_ai_usage_records() TO service_role;

DO $$
BEGIN
  PERFORM cron.unschedule('cleanup-ai-usage-records')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-ai-usage-records');

  PERFORM cron.schedule(
    'cleanup-ai-usage-records',
    '35 3 * * *',
    'SELECT public.cleanup_ai_usage_records()'
  );
END $$;
