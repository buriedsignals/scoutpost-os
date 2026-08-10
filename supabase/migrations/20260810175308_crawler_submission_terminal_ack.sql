-- A very fast Workflow can finish before the task-start API response is
-- acknowledged. Preserve the terminal batch state while still recording the
-- Render task ID for correlation and reconciliation.
CREATE OR REPLACE FUNCTION public.mark_crawler_batch_submitted(
  p_batch_id uuid,
  p_reservation_token uuid,
  p_render_task_run_id text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_changed int;
BEGIN
  IF length(trim(COALESCE(p_render_task_run_id, ''))) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid Render task run id';
  END IF;
  UPDATE public.crawler_batches b
     SET render_task_run_id = p_render_task_run_id,
         submitted_at = now(),
         status = CASE WHEN b.status = 'pending' THEN 'submitted' ELSE b.status END,
         updated_at = now()
   WHERE b.id = p_batch_id
     AND b.status IN ('pending', 'running', 'complete', 'failed')
     AND b.render_task_run_id IS NULL
     AND b.submission_reservation_token = p_reservation_token;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed = 1;
END;
$$;
