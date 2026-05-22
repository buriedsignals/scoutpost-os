-- Preserve listing/index provenance separately from the source article URL.
-- Page Scout Phase B writes article permalinks to source_url and the monitored
-- listing URL to discovered_from_url.

ALTER TABLE public.information_units
  ADD COLUMN IF NOT EXISTS discovered_from_url TEXT;

ALTER TABLE public.unit_occurrences
  ADD COLUMN IF NOT EXISTS discovered_from_url TEXT;

CREATE INDEX IF NOT EXISTS idx_information_units_discovered_from_url
  ON public.information_units(user_id, discovered_from_url)
  WHERE discovered_from_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_unit_occurrences_discovered_from_url
  ON public.unit_occurrences(user_id, discovered_from_url)
  WHERE discovered_from_url IS NOT NULL;
