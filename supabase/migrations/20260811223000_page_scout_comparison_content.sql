-- Preserve full Page Scout evidence while comparing a quality-gated semantic
-- projection. Non-Page writers leave both columns null.
ALTER TABLE public.raw_captures
  ADD COLUMN IF NOT EXISTS comparison_md text,
  ADD COLUMN IF NOT EXISTS comparison_strategy text;

COMMENT ON COLUMN public.raw_captures.comparison_md IS
  'Optional Page Scout semantic Markdown used for canonical comparison; content_md remains the unmodified provider evidence document.';

COMMENT ON COLUMN public.raw_captures.comparison_strategy IS
  'Page Scout comparison projection: main, role_main, article, provider_main, or full.';
