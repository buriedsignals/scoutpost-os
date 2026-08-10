-- Civic accountability v2: source-controlled initial imports and immutable
-- queue semantics. These columns are additive so workers can be rolled out
-- before the compatibility path is removed.

ALTER TABLE public.civic_extraction_queue
  ADD COLUMN IF NOT EXISTS ingestion_mode text NOT NULL DEFAULT 'scheduled',
  ADD COLUMN IF NOT EXISTS civic_policy_version text NOT NULL DEFAULT 'civic-accountability-v2',
  ADD COLUMN IF NOT EXISTS semantics_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.civic_extraction_queue
  DROP CONSTRAINT IF EXISTS civic_extraction_queue_ingestion_mode_check;

ALTER TABLE public.civic_extraction_queue
  ADD CONSTRAINT civic_extraction_queue_ingestion_mode_check
  CHECK (ingestion_mode IN ('initial', 'scheduled', 'repair'));

CREATE INDEX IF NOT EXISTS idx_civic_queue_ingestion_mode_status
  ON public.civic_extraction_queue (ingestion_mode, status, created_at);

CREATE TABLE IF NOT EXISTS public.civic_run_alert_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scout_run_id uuid NOT NULL REFERENCES public.scout_runs(id) ON DELETE CASCADE,
  queue_id uuid NOT NULL REFERENCES public.civic_extraction_queue(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES public.information_units(id) ON DELETE CASCADE,
  statement text NOT NULL,
  source_url text NOT NULL,
  source_title text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (queue_id, unit_id)
);
ALTER TABLE public.civic_run_alert_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.civic_run_alert_items FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.civic_run_alert_items TO service_role;

-- A document worker may complete before its siblings. Settlement is therefore
-- fenced on every run queue row reaching a terminal state; semantic-zero done
-- rows are successes, while a terminal document failure makes the settled run
-- fail. This replaces the old first-document-wins status update.
CREATE OR REPLACE FUNCTION public.finalize_civic_run_doc(
  p_queue_id uuid,
  p_worker_id text,
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
  v_open int;
  v_failed int;
  v_queue_run_id uuid;
  v_queue_user_id uuid;
  v_queue_scout_id uuid;
BEGIN
  -- Lock and derive all tenancy/run identifiers from the queue row. The worker
  -- receives p_run_id only as an integrity assertion, never as authority to
  -- settle an unrelated run.
  SELECT scout_run_id, user_id, scout_id
    INTO v_queue_run_id, v_queue_user_id, v_queue_scout_id
    FROM public.civic_extraction_queue
   WHERE id = p_queue_id AND status = 'processing' AND lease_owner = p_worker_id
     AND lease_expires_at > now()
   FOR UPDATE;
  IF NOT FOUND OR p_run_id IS DISTINCT FROM v_queue_run_id THEN RETURN false; END IF;
  IF v_queue_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.scout_runs r
     WHERE r.id = v_queue_run_id AND r.user_id = v_queue_user_id
       AND r.scout_id = v_queue_scout_id
  ) THEN RETURN false; END IF;

  UPDATE public.civic_extraction_queue
     SET status = 'done', raw_capture_id = COALESCE(p_raw_capture_id, raw_capture_id),
         lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
         completed_at = now(), updated_at = now()
   WHERE id = p_queue_id AND status = 'processing' AND lease_owner = p_worker_id
     AND lease_expires_at > now();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RETURN false; END IF;
  IF v_queue_run_id IS NULL THEN RETURN true; END IF;

  SELECT count(*) FILTER (WHERE status IN ('pending', 'processing')),
         count(*) FILTER (WHERE status = 'failed')
    INTO v_open, v_failed
    FROM public.civic_extraction_queue WHERE scout_run_id = v_queue_run_id;
  UPDATE public.scout_runs
     SET units_created_count = COALESCE(units_created_count, 0) + COALESCE(p_created, 0),
         units_merged_count = COALESCE(units_merged_count, 0) + COALESCE(p_merged, 0),
         articles_count = COALESCE(articles_count, 0) + COALESCE(p_created, 0),
         merged_existing_count = COALESCE(merged_existing_count, 0) + COALESCE(p_merged, 0),
         criteria_status = COALESCE(criteria_status, false) OR (p_created > 0),
         status = CASE WHEN v_open = 0 AND v_failed > 0 THEN 'error'
                       WHEN v_open = 0 THEN 'success' ELSE status END,
         stage = CASE WHEN v_open = 0 THEN 'finalize' ELSE stage END,
         scraper_status = CASE WHEN v_open = 0 AND v_failed = 0 THEN true ELSE scraper_status END,
         notification_status = CASE WHEN v_open = 0 AND v_failed > 0 THEN 'not_applicable'
                                    WHEN v_open = 0 AND COALESCE(p_created, 0) = 0 THEN 'skipped'
                                    WHEN v_open = 0 THEN 'pending' ELSE notification_status END,
         completed_at = CASE WHEN v_open = 0 THEN now() ELSE completed_at END
   WHERE id = v_queue_run_id AND user_id = v_queue_user_id AND scout_id = v_queue_scout_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_civic_run_doc(uuid, text, uuid, int, int, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_civic_run_doc(uuid, text, uuid, int, int, uuid) TO service_role;
