-- Persist Beat retrieval canary metrics so Firecrawl and Exa runs can be
-- compared from database evidence, not Edge logs.

CREATE TABLE IF NOT EXISTS public.beat_ab_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scout_id UUID NOT NULL REFERENCES public.scouts(id) ON DELETE CASCADE,
  run_id UUID REFERENCES public.scout_runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  retrieval TEXT NOT NULL CHECK (retrieval IN ('firecrawl', 'exa')),
  raw_hit_count INT NOT NULL DEFAULT 0,
  dated_hit_count INT NOT NULL DEFAULT 0,
  final_hit_count INT NOT NULL DEFAULT 0,
  units_created INT NOT NULL DEFAULT 0,
  units_merged INT NOT NULL DEFAULT 0,
  locality_score REAL,
  freshness_score REAL,
  total_cost_dollars NUMERIC(12,6),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_beat_ab_runs_scout_time
  ON public.beat_ab_runs(scout_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_beat_ab_runs_retrieval_time
  ON public.beat_ab_runs(retrieval, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_beat_ab_runs_run
  ON public.beat_ab_runs(run_id)
  WHERE run_id IS NOT NULL;

ALTER TABLE public.beat_ab_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS beat_ab_runs_user_read ON public.beat_ab_runs;
CREATE POLICY beat_ab_runs_user_read
  ON public.beat_ab_runs
  FOR SELECT
  USING ((SELECT auth.uid()) = user_id);
