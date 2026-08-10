-- Delivery state is separate from an editor's assessment of the promise.
ALTER TABLE public.promises
  ADD COLUMN IF NOT EXISTS due_notified_at timestamptz;

-- Legacy pre-canonical rows remain readable, while every newly linked Civic
-- tracker must satisfy the date contract enforced by the shared policy.
ALTER TABLE public.promises
  ADD CONSTRAINT promises_canonical_date_contract
  CHECK (
    unit_id IS NULL
    OR (due_date IS NOT NULL AND date_confidence IN ('high', 'medium', 'low'))
  ) NOT VALID;

UPDATE public.promises
   SET status = 'new',
       due_notified_at = COALESCE(due_notified_at, updated_at, created_at, now())
 WHERE status = 'notified';

ALTER TABLE public.promises
  DROP CONSTRAINT IF EXISTS promises_status_check;
ALTER TABLE public.promises
  ADD CONSTRAINT promises_status_check
  CHECK (status IN ('new', 'in_progress', 'fulfilled', 'broken'));

CREATE TABLE public.promise_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promise_id uuid NOT NULL REFERENCES public.promises(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL CHECK (to_status IN ('new', 'in_progress', 'fulfilled', 'broken')),
  reason text,
  evidence_url text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, promise_id, idempotency_key)
);

CREATE TABLE public.promise_reminder_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  promise_id uuid NOT NULL REFERENCES public.promises(id) ON DELETE CASCADE,
  due_date date NOT NULL,
  provider_idempotency_key text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'sending', 'provider_accepted', 'sent', 'failed')),
  lease_owner text,
  lease_expires_at timestamptz,
  provider_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (user_id, promise_id, due_date)
);

ALTER TABLE public.promise_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promise_reminder_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.promise_status_history, public.promise_reminder_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.promise_status_history, public.promise_reminder_deliveries TO service_role;

CREATE INDEX promise_reminder_deliveries_claim_idx
  ON public.promise_reminder_deliveries(state, lease_expires_at);

CREATE OR REPLACE FUNCTION public.claim_due_promise_reminders(
  p_worker_id text,
  p_due_on_or_before date,
  p_limit int DEFAULT 100,
  p_lease_seconds int DEFAULT 900
)
RETURNS TABLE (
  delivery_id uuid,
  promise_id uuid,
  user_id uuid,
  promise_text text,
  source_url text,
  source_title text,
  due_date date,
  provider_idempotency_key text,
  needs_provider_submission boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(500, GREATEST(1, COALESCE(p_limit, 100)));
  v_lease int := LEAST(3600, GREATEST(60, COALESCE(p_lease_seconds, 900)));
BEGIN
  IF length(trim(COALESCE(p_worker_id, ''))) = 0 THEN
    RAISE EXCEPTION 'worker id is required';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT p.id, p.user_id, p.promise_text, p.source_url, p.source_title, p.due_date
      FROM public.promises p
     WHERE p.due_date IS NOT NULL
       AND p.due_date <= p_due_on_or_before
       AND p.status IN ('new', 'in_progress')
       AND p.due_notified_at IS NULL
     ORDER BY p.due_date, p.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT v_limit
  ), deliveries AS (
    INSERT INTO public.promise_reminder_deliveries AS delivery (
      user_id, promise_id, due_date, provider_idempotency_key, state,
      lease_owner, lease_expires_at, updated_at
    )
    SELECT c.user_id, c.id, c.due_date,
           'civic/reminder/' || c.user_id::text || '/' || c.id::text || '/' || c.due_date::text,
           'sending', p_worker_id, now() + make_interval(secs => v_lease), now()
      FROM candidates c
    ON CONFLICT ON CONSTRAINT promise_reminder_deliveries_user_id_promise_id_due_date_key DO UPDATE
      SET state = 'sending', lease_owner = p_worker_id,
          lease_expires_at = now() + make_interval(secs => v_lease),
          updated_at = now(), last_error = NULL
      WHERE delivery.state IN ('pending', 'failed')
         OR (delivery.state = 'sending'
             AND delivery.lease_expires_at <= now())
    RETURNING delivery.id, delivery.promise_id, delivery.user_id,
              delivery.due_date, delivery.provider_idempotency_key, true AS needs_provider_submission
  ), accepted AS (
    UPDATE public.promise_reminder_deliveries d
       SET lease_owner = p_worker_id,
           lease_expires_at = now() + make_interval(secs => v_lease),
           updated_at = now()
      FROM candidates c
     WHERE c.id = d.promise_id AND d.state = 'provider_accepted'
     RETURNING d.id, d.promise_id, d.user_id, d.due_date,
               d.provider_idempotency_key, false AS needs_provider_submission
  )
  SELECT d.id, c.id, c.user_id, c.promise_text, c.source_url, c.source_title,
         d.due_date, d.provider_idempotency_key, d.needs_provider_submission
    FROM (SELECT * FROM deliveries UNION ALL SELECT * FROM accepted) d
    JOIN candidates c ON c.id = d.promise_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_due_promise_reminders_provider_accepted(
  p_worker_id text,
  p_delivery_ids uuid[],
  p_provider_id text DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count int;
BEGIN
  UPDATE public.promise_reminder_deliveries d
     SET state = 'provider_accepted', provider_id = COALESCE(p_provider_id, d.provider_id),
         updated_at = now()
   WHERE d.id = ANY(COALESCE(p_delivery_ids, ARRAY[]::uuid[]))
     AND d.state = 'sending' AND d.lease_owner = p_worker_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_due_promise_reminders(
  p_worker_id text,
  p_delivery_ids uuid[],
  p_success boolean,
  p_error text DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count int;
BEGIN
  WITH updated AS (
    UPDATE public.promise_reminder_deliveries d
       SET state = CASE WHEN p_success THEN 'sent' ELSE 'failed' END,
           sent_at = CASE WHEN p_success THEN now() ELSE sent_at END,
           last_error = CASE WHEN p_success THEN NULL ELSE left(COALESCE(p_error, 'delivery failed'), 2000) END,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE d.id = ANY(COALESCE(p_delivery_ids, ARRAY[]::uuid[]))
       AND d.state IN ('sending', 'provider_accepted') AND d.lease_owner = p_worker_id
     RETURNING d.promise_id
  ), stamped AS (
    UPDATE public.promises p
       SET due_notified_at = now(), updated_at = now()
     WHERE p_success AND p.id IN (SELECT promise_id FROM updated)
     RETURNING p.id
  ) SELECT count(*)::int INTO v_count FROM updated;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_due_promise_reminders(text, date, int, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_due_promise_reminders_provider_accepted(text, uuid[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_due_promise_reminders(text, uuid[], boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_promise_reminders(text, date, int, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_due_promise_reminders_provider_accepted(text, uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_due_promise_reminders(text, uuid[], boolean, text) TO service_role;

CREATE OR REPLACE FUNCTION public.transition_civic_promise_status(
  p_promise_id uuid,
  p_user_id uuid,
  p_target_status text,
  p_expected_updated_at timestamptz,
  p_reason text DEFAULT NULL,
  p_evidence_url text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_promise public.promises%ROWTYPE;
  v_existing public.promise_status_history%ROWTYPE;
  v_from_status text;
BEGIN
  IF p_target_status NOT IN ('new', 'in_progress', 'fulfilled', 'broken') THEN
    RAISE EXCEPTION 'invalid target status';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.promise_status_history
     WHERE user_id = p_user_id AND promise_id = p_promise_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      SELECT * INTO v_promise FROM public.promises WHERE id = p_promise_id AND user_id = p_user_id;
      RETURN jsonb_build_object('idempotent', true, 'promise', to_jsonb(v_promise));
    END IF;
  END IF;
  SELECT * INTO v_promise FROM public.promises
   WHERE id = p_promise_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'promise not found'; END IF;
  IF p_expected_updated_at IS NULL OR v_promise.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'promise version conflict';
  END IF;
  IF NOT (
    (v_promise.status = 'new' AND p_target_status IN ('in_progress', 'fulfilled', 'broken')) OR
    (v_promise.status = 'in_progress' AND p_target_status IN ('fulfilled', 'broken')) OR
    (v_promise.status IN ('fulfilled', 'broken') AND p_target_status = 'in_progress')
  ) THEN RAISE EXCEPTION 'invalid promise status transition'; END IF;
  v_from_status := v_promise.status;
  UPDATE public.promises SET status = p_target_status, updated_at = now()
   WHERE id = p_promise_id RETURNING * INTO v_promise;
  INSERT INTO public.promise_status_history(promise_id, user_id, from_status, to_status, reason, evidence_url, idempotency_key)
    VALUES (p_promise_id, p_user_id, v_from_status, p_target_status, p_reason, p_evidence_url, p_idempotency_key);
  RETURN jsonb_build_object('idempotent', false, 'promise', to_jsonb(v_promise));
END;
$$;

REVOKE ALL ON FUNCTION public.transition_civic_promise_status(uuid, uuid, text, timestamptz, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_civic_promise_status(uuid, uuid, text, timestamptz, text, text, text) TO service_role;
