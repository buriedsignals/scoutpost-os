-- Durable, per-document membership for Civic Scout.  `processed_pdf_urls` is
-- retained only as a legacy convenience cache: it is capped and cannot prove
-- that a large archive has been baselined.  This table is the authoritative
-- source for import-off "new document" detection.
CREATE TABLE public.civic_document_baselines (
  scout_id uuid NOT NULL REFERENCES public.scouts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_url text NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scout_id, source_url)
);

CREATE INDEX civic_document_baselines_user_scout_idx
  ON public.civic_document_baselines (user_id, scout_id);

ALTER TABLE public.civic_document_baselines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.civic_document_baselines FROM anon, authenticated;
GRANT ALL ON TABLE public.civic_document_baselines TO service_role;
