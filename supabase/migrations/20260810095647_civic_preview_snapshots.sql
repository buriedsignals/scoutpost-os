-- Server-owned, short-lived preview state.  It is deliberately not exposed
-- through the Data API: a browser receives only its opaque UUID token.
CREATE TABLE public.civic_preview_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  policy_version text NOT NULL,
  criteria text,
  tracked_urls jsonb NOT NULL,
  documents jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_by_scout_id uuid REFERENCES public.scouts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(tracked_urls) = 'array'),
  CHECK (jsonb_typeof(documents) = 'array')
);

ALTER TABLE public.civic_preview_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.civic_preview_snapshots FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.civic_preview_snapshots TO service_role;

CREATE INDEX civic_preview_snapshots_owner_expiry_idx
  ON public.civic_preview_snapshots(user_id, expires_at DESC);

ALTER TABLE public.civic_extraction_queue
  ADD COLUMN IF NOT EXISTS preview_snapshot_id uuid
    REFERENCES public.civic_preview_snapshots(id) ON DELETE SET NULL;

CREATE INDEX civic_extraction_queue_preview_snapshot_idx
  ON public.civic_extraction_queue(preview_snapshot_id)
  WHERE preview_snapshot_id IS NOT NULL;
