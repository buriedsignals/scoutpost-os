-- Civic per-URL canonical baselines (SCRAPING-MIGRATION-PRD U4).
--
-- Civic scouts track many URLs per scout, so change detection compares against
-- the latest canonical baseline for a specific (scout_id, source_url). The
-- existing 00060 index is (scout_id, canonicalizer_version, captured_at) — good
-- for web scouts (one URL) but not selective per source_url. Add a partial
-- index covering the per-URL lookup that hashChangeStatusForUrl issues.

CREATE INDEX IF NOT EXISTS idx_raw_scout_url_canonical_time
  ON public.raw_captures (scout_id, source_url, captured_at DESC)
  WHERE canonical_content_sha256 IS NOT NULL;
