-- Recover unclaimed ambiguous Render submissions promptly. Batch claiming is
-- atomic, so an originally accepted task that starts after release sees the
-- failed batch and exits without processing duplicate work.

CREATE INDEX crawler_batches_pending_submission_recovery_idx
  ON public.crawler_batches(submission_reserved_at)
  WHERE status = 'pending'
    AND render_task_run_id IS NULL
    AND submission_reservation_token IS NOT NULL;

CREATE OR REPLACE FUNCTION public.release_stale_crawler_submissions(
  p_grace_seconds int DEFAULT 120
) RETURNS TABLE (batches_released int, jobs_requeued int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_grace_seconds < 60 OR p_grace_seconds > 900 THEN
    RAISE EXCEPTION 'invalid submission grace';
  END IF;

  RETURN QUERY
  WITH stale AS (
    UPDATE public.crawler_batches b
       SET status = 'failed', completed_at = now(),
           render_metrics = b.render_metrics || jsonb_build_object(
             'submission_error', 'ambiguous start remained unclaimed'
           ),
           updated_at = now()
     WHERE b.status = 'pending'
       AND b.render_task_run_id IS NULL
       AND b.submission_reservation_token IS NOT NULL
       AND b.submission_reserved_at <= now()
         - make_interval(secs => p_grace_seconds)
    RETURNING b.id
  ), released AS (
    UPDATE public.crawler_jobs j
       SET status = 'queued', batch_id = NULL, batched_at = NULL,
           updated_at = now()
      FROM stale s
     WHERE j.batch_id = s.id AND j.status = 'batched'
    RETURNING 1
  )
  SELECT
    (SELECT count(*)::int FROM stale),
    (SELECT count(*)::int FROM released);
END;
$$;

REVOKE ALL ON FUNCTION public.release_stale_crawler_submissions(int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_stale_crawler_submissions(int)
  TO service_role;
