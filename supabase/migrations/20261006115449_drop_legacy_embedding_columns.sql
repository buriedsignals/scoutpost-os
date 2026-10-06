-- Drop the legacy 1,536d embedding columns and the RPCs that read them.
--
-- Since the 768d cutover (00082/00083, 2026-07) every writer fills
-- embedding_v2/embedding_model_v2 and every search uses the *_v2 RPCs.
-- Production on 2026-10-06: no code path, view, trigger or live function reads
-- `embedding`/`embedding_model` on these tables (the cutover stage table has
-- its own columns of the same name and is kept for re-embedding repairs), and
-- the legacy writer was dropped in 20261006094847. Their HNSW indexes go with
-- the columns.
DROP FUNCTION IF EXISTS public.check_unit_dedup(extensions.vector, UUID, REAL, INT);
DROP FUNCTION IF EXISTS public.semantic_search_units(
  extensions.vector, UUID, UUID, UUID, INT, TEXT, INT
);
DROP FUNCTION IF EXISTS public.semantic_search_reflections(
  extensions.vector, UUID, UUID, INT
);

ALTER TABLE public.information_units
  DROP COLUMN IF EXISTS embedding,
  DROP COLUMN IF EXISTS embedding_model;
ALTER TABLE public.entities
  DROP COLUMN IF EXISTS embedding,
  DROP COLUMN IF EXISTS embedding_model;
ALTER TABLE public.reflections
  DROP COLUMN IF EXISTS embedding,
  DROP COLUMN IF EXISTS embedding_model;
ALTER TABLE public.execution_records
  DROP COLUMN IF EXISTS embedding,
  DROP COLUMN IF EXISTS embedding_model;
