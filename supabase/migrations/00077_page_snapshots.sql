-- Page Archive: evidence-grade Page Scout snapshots (PAGE-ARCHIVE-PRD U2).
--
-- page_snapshots is the durable record of a page updating: one row per capture
-- (baseline or change), artifacts content-addressed in the private
-- page-snapshots bucket, no TTL — expires_at stays NULL by design (KTD7);
-- evidence is deleted only with the scout or account. FK cascades remove rows
-- but can never reach storage objects: _shared/snapshot_store.ts's
-- deleteScoutSnapshots owns the object side of the deletion contract (R3).
--
-- Fidelity tiers (KTD9): full (local render via the scrape-service),
-- rendered_thirdparty (same-fetch Firecrawl artifacts on anti-bot hosts),
-- markdown_only (universal last-resort degrade — a notified change never ends
-- with zero archival record). Every row persists the canonical markdown as a
-- .md object so the content record outlives the raw_captures TTL.

-- Per-scout gates. archive_enabled is Pro/Team-gated at runtime (KTD6);
-- wayback_enabled gives sensitive investigations a per-scout opt-out from
-- public Internet Archive submission (KTD5).
ALTER TABLE scouts ADD COLUMN IF NOT EXISTS archive_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE scouts ADD COLUMN IF NOT EXISTS wayback_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS page_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scout_id UUID NOT NULL REFERENCES scouts(id) ON DELETE CASCADE,
  scout_run_id UUID REFERENCES scout_runs(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  raw_capture_id UUID REFERENCES raw_captures(id) ON DELETE SET NULL,
  capture_kind TEXT NOT NULL CHECK (capture_kind IN ('baseline', 'change')),
  fidelity TEXT NOT NULL CHECK (fidelity IN ('full', 'rendered_thirdparty', 'markdown_only')),
  served_by TEXT CHECK (served_by IN ('crawl4ai', 'firecrawl')),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requested_url TEXT NOT NULL,
  final_url TEXT,
  http_status INT,
  response_headers JSONB,
  -- Binding to the exact markdown baseline that fired (KTD4)
  content_sha256 TEXT,
  canonical_content_sha256 TEXT,
  -- The .md content record — present on every row (KTD9)
  markdown_sha256 TEXT NOT NULL,
  markdown_path TEXT NOT NULL,
  markdown_bytes BIGINT,
  -- Full-fidelity artifacts (NULL below 'full')
  mhtml_sha256 TEXT,
  mhtml_path TEXT,
  mhtml_bytes BIGINT,
  -- Screenshot: ours (full, PNG verbatim) or Firecrawl-delivered (rendered_thirdparty)
  screenshot_sha256 TEXT,
  screenshot_path TEXT,
  screenshot_bytes BIGINT,
  -- rendered_thirdparty rawHtml (KTD9)
  rawhtml_sha256 TEXT,
  rawhtml_path TEXT,
  rawhtml_bytes BIGINT,
  -- Trust layer (KTD5) — written by U4
  manifest_path TEXT,
  tsa_status TEXT NOT NULL DEFAULT 'pending',
  tsa_path TEXT,
  wayback_status TEXT NOT NULL DEFAULT 'pending',
  wayback_url TEXT,
  -- NULL by design: no TTL (KTD7). Column exists so per-tier retention stays
  -- a config change, not a migration. Cleanup crons must NOT reference this
  -- table (see docs/supabase/retention.md).
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_page_snapshots_scout_time
  ON page_snapshots (scout_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_snapshots_user
  ON page_snapshots (user_id);
-- FK support indexes: scout_runs and raw_captures are purged nightly by cron
-- (00006 / 00014), and their ON DELETE SET NULL actions would otherwise scan
-- this table — which by design never shrinks — once per deleted row.
CREATE INDEX IF NOT EXISTS idx_page_snapshots_scout_run
  ON page_snapshots (scout_run_id) WHERE scout_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_page_snapshots_raw_capture
  ON page_snapshots (raw_capture_id) WHERE raw_capture_id IS NOT NULL;

-- Owner read; every write path is service-role (bypasses RLS).
-- DROP-before-CREATE (Postgres has no CREATE POLICY IF NOT EXISTS) so a re-run
-- on an OSS stack — migration-history reset or a db push after a partial apply —
-- doesn't abort with "policy already exists". Matches 00066's idempotent shape.
ALTER TABLE page_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS page_snapshots_owner_read ON page_snapshots;
CREATE POLICY page_snapshots_owner_read ON page_snapshots FOR SELECT
  USING ((SELECT auth.uid()) = user_id);

-- Private evidence bucket (KTD3). file_size_limit (26 MB) backs the
-- service-side 25 MB per-artifact cap (R8) at the storage layer, so a bug in
-- any writer path cannot silently void the cost model's size invariant.
-- DO UPDATE, not DO NOTHING: a pre-existing hand-created bucket (staging/OSS
-- dashboard defaults) must be forced private with the size cap, or evidence
-- objects could be world-readable and the storage-layer backstop silently
-- absent.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('page-snapshots', 'page-snapshots', FALSE, 27262976)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit;

-- Storage RLS: owner-select by path prefix ({user_id}/{scout_id}/...), which
-- lets OSS clients mint signed URLs directly with a user JWT while SaaS goes
-- through the snapshots Edge Function. No user write policies — uploads and
-- deletes are service-role only.
DROP POLICY IF EXISTS page_snapshots_objects_owner_read ON storage.objects;
CREATE POLICY page_snapshots_objects_owner_read ON storage.objects FOR SELECT
  USING (
    bucket_id = 'page-snapshots'
    AND (SELECT auth.uid())::text = (storage.foldername(name))[1]
  );
