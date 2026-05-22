-- Persist source-level run counters for CLI/agent diagnostics.
-- These values were already returned by some executors, but were not stored
-- in scout_runs, so `scout scouts show` could not expose them after the fact.

ALTER TABLE public.scout_runs
  ADD COLUMN IF NOT EXISTS sources_scraped INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sources_failed INT NOT NULL DEFAULT 0;

UPDATE public.scout_runs
SET
  sources_scraped = COALESCE(sources_scraped, 0),
  sources_failed = COALESCE(sources_failed, 0)
WHERE sources_scraped IS NULL OR sources_failed IS NULL;

ALTER TABLE public.scout_runs
  ALTER COLUMN sources_scraped SET DEFAULT 0,
  ALTER COLUMN sources_scraped SET NOT NULL,
  ALTER COLUMN sources_failed SET DEFAULT 0,
  ALTER COLUMN sources_failed SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scout_runs_source_failures
  ON public.scout_runs(sources_failed, started_at DESC)
  WHERE sources_failed > 0;
