-- Drop the July 2026 768d cutover tooling.
--
-- The OpenRouter Gemini 768d cutover finished in July. On 2026-10-07 the
-- staging table was empty, nothing in code, cron or other SQL called these
-- RPCs, and the only rows without a target vector are Fleet (transport)
-- events, which are deliberately not embedded (exact positional identity).
-- scripts/ops/backfill-embeddings.ts, the only caller, is removed with them.
DROP FUNCTION IF EXISTS public.apply_embedding_v2_cutover();
DROP FUNCTION IF EXISTS public.embedding_v2_cutover_inventory();
DROP FUNCTION IF EXISTS public.stage_embedding_v2_cutover(TEXT, UUID, extensions.vector, TEXT);
DROP FUNCTION IF EXISTS public.write_embedding_v2(TEXT, UUID, extensions.vector, TEXT);
DROP TABLE IF EXISTS public.embedding_v2_cutover_stage;
