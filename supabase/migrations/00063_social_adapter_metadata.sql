-- Persist social profile resolver/adapter diagnostics where operators and
-- agent-facing run tools can read them without parsing Edge logs.

ALTER TABLE public.scouts
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.scout_runs
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE public.scouts
SET metadata = COALESCE(metadata, '{}'::jsonb)
WHERE metadata IS NULL;

UPDATE public.scout_runs
SET metadata = COALESCE(metadata, '{}'::jsonb)
WHERE metadata IS NULL;

ALTER TABLE public.scouts
  ALTER COLUMN metadata SET DEFAULT '{}'::jsonb,
  ALTER COLUMN metadata SET NOT NULL;

ALTER TABLE public.scout_runs
  ALTER COLUMN metadata SET DEFAULT '{}'::jsonb,
  ALTER COLUMN metadata SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scouts_social_adapter_status
  ON public.scouts ((metadata->>'adapter_status'))
  WHERE type = 'social' AND metadata ? 'adapter_status';

CREATE INDEX IF NOT EXISTS idx_scout_runs_social_adapter_status
  ON public.scout_runs ((metadata->>'adapter_status'), started_at DESC)
  WHERE metadata ? 'adapter_status';
