-- 00085_targeted_civic_queue_claim.sql
-- Allow authenticated internal workers to drain a specific scout run. The
-- default NULL parameter preserves the global oldest-first cron behavior while
-- benchmarks can exercise their own queue rows without consuming unrelated
-- production work.

DROP FUNCTION IF EXISTS public.claim_civic_queue_item();

CREATE FUNCTION public.claim_civic_queue_item(
  p_scout_run_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  scout_id uuid,
  scout_run_id uuid,
  source_url text,
  doc_kind text,
  attempts int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed_id uuid;
BEGIN
  WITH candidate AS (
    SELECT q.id
      FROM public.civic_extraction_queue q
     WHERE (
       q.status = 'pending'
       OR (
         q.status = 'processing'
         AND q.updated_at < NOW() - INTERVAL '30 minutes'
       )
     )
       AND (
         p_scout_run_id IS NULL
         OR q.scout_run_id = p_scout_run_id
       )
     ORDER BY q.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  UPDATE public.civic_extraction_queue q
     SET status = 'processing',
         attempts = q.attempts + 1,
         updated_at = NOW()
    FROM candidate
   WHERE q.id = candidate.id
  RETURNING q.id INTO claimed_id;

  IF claimed_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT q.id,
         q.user_id,
         q.scout_id,
         q.scout_run_id,
         q.source_url,
         q.doc_kind,
         q.attempts
    FROM public.civic_extraction_queue q
   WHERE q.id = claimed_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_civic_queue_item(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_civic_queue_item(uuid)
  TO service_role;
