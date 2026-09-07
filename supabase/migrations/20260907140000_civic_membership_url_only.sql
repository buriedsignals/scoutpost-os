-- Civic document membership: the creation baseline records which documents
-- an archive already lists (URL membership) so a scheduled run can detect
-- NEW documents and queue at most two. Content hashes are recorded only for
-- documents that were actually parsed (worker success, or the bounded
-- same-URL replacement check on recent documents). Parsing every archive
-- document at creation time — and the 100-document cap that bounded it —
-- is gone: a Legistar calendar lists ~500 documents and must still schedule.
ALTER TABLE public.civic_document_baselines
  ALTER COLUMN content_sha256 DROP NOT NULL;

COMMENT ON COLUMN public.civic_document_baselines.content_sha256 IS
  'sha256 of the parsed document text when it has been parsed; NULL for URL-only membership recorded at creation or enqueue.';
