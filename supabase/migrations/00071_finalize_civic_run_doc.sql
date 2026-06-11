-- 00071_finalize_civic_run_doc.sql
-- Exactly-once, additive finalization for a single civic queue document.
--
-- A civic scout run fans out to multiple queue rows (one per document), each
-- processed by a separate civic-extract-worker invocation. The worker used to
-- call markRunSuccess, which does an absolute SET of the run's unit counts, so
-- the last document overwrote the earlier ones (the run under-reported units).
-- It also marked the queue row 'done' in a separate, later UPDATE, so a worker
-- crash between the two left the row re-claimable (claim_civic_queue_item
-- re-claims 'processing' rows older than 30 minutes) and reprocessable.
--
-- This RPC does both in one statement set, gated on winning the
-- processing->done transition:
--   * flip the queue row processing->done (only the caller that wins counts);
--   * bump the run's counts ADDITIVELY so multiple documents accumulate;
--   * keep notification_status monotonic (a later empty document must not
--     downgrade a 'sent'/'pending' status to 'skipped').
-- Returns true when this caller performed the finalization, false when the row
-- was already done (a concurrent/duplicate invocation) so the caller can skip
-- the notification + URL bookkeeping and keep those exactly-once too.

CREATE OR REPLACE FUNCTION finalize_civic_run_doc(
  p_queue_id uuid,
  p_run_id uuid,
  p_created int,
  p_merged int,
  p_raw_capture_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows int;
BEGIN
  UPDATE civic_extraction_queue
  SET status = 'done',
      raw_capture_id = COALESCE(p_raw_capture_id, raw_capture_id),
      updated_at = NOW()
  WHERE id = p_queue_id
    AND status = 'processing';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    -- Already finalized by a concurrent or prior invocation; do not re-count.
    RETURN false;
  END IF;

  IF p_run_id IS NOT NULL THEN
    UPDATE scout_runs
    SET status = 'success',
        stage = 'finalize',
        error_class = NULL,
        error_message = NULL,
        scraper_status = true,
        units_created_count   = COALESCE(units_created_count, 0)   + p_created,
        units_merged_count    = COALESCE(units_merged_count, 0)    + p_merged,
        articles_count        = COALESCE(articles_count, 0)        + p_created,
        merged_existing_count = COALESCE(merged_existing_count, 0) + p_merged,
        criteria_status = COALESCE(criteria_status, false) OR (p_created > 0),
        notification_status = CASE
          WHEN p_created > 0 AND COALESCE(notification_status, '') <> 'sent'
            THEN 'pending'
          WHEN COALESCE(notification_status, '') = ''
            THEN 'skipped'
          ELSE notification_status
        END,
        completed_at = NOW()
    WHERE id = p_run_id;
  END IF;

  RETURN true;
END;
$$;

-- SECURITY DEFINER grant hygiene (post-00055 convention): only the service
-- role (workers) may call this; never the anon/authenticated PostgREST roles.
REVOKE ALL ON FUNCTION finalize_civic_run_doc(uuid, uuid, int, int, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION finalize_civic_run_doc(uuid, uuid, int, int, uuid)
  TO service_role;
