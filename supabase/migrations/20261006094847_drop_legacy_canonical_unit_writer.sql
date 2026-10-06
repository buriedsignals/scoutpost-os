-- Drop the legacy 1,536d canonical-unit writer.
--
-- Since the 768d cutover (00082/00083, 2026-07) every writer calls
-- upsert_canonical_unit_v2 (Edge _shared/unit_dedup.ts and persist_civic_item).
-- Production on 2026-10-06: no function body or code path references the
-- legacy RPC, and none of the 3,384 units extracted in the previous 30 days
-- carries a legacy `embedding`. Keeping it only invited calls into the stale
-- vector space. The legacy embedding columns and their data are unchanged.
DROP FUNCTION IF EXISTS public.upsert_canonical_unit(
  UUID, TEXT, TEXT, TEXT[], extensions.vector, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, DATE, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT, UUID, UUID, UUID,
  JSONB, REAL, REAL, INT, BOOLEAN, REAL, BOOLEAN, TEXT
);
