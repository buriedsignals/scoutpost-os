-- One durable, fenced delivery record for every settled scheduled Civic run
-- with alertable new canonical items.  This separates provider acceptance
-- from finalization so a retry always reuses the same provider key.
CREATE TABLE public.civic_run_alert_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scout_run_id uuid NOT NULL UNIQUE REFERENCES public.scout_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider_idempotency_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'sending', 'provider_accepted', 'sent', 'failed')),
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  provider_id text,
  provider_accepted_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.civic_run_alert_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.civic_run_alert_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.civic_run_alert_deliveries TO service_role;

CREATE INDEX civic_run_alert_deliveries_claim_idx
  ON public.civic_run_alert_deliveries(state, lease_expires_at);

-- Only settlement can create alert intent. This trigger deliberately checks
-- the queue mode in the database, not the worker branch.
CREATE OR REPLACE FUNCTION public.seal_civic_run_alert_delivery()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'success' AND OLD.status IS DISTINCT FROM 'success'
    AND EXISTS (
      SELECT 1 FROM public.civic_extraction_queue q
      WHERE q.scout_run_id = NEW.id AND q.ingestion_mode = 'scheduled'
    )
    AND EXISTS (SELECT 1 FROM public.civic_run_alert_items i WHERE i.scout_run_id = NEW.id)
  THEN
    INSERT INTO public.civic_run_alert_deliveries (
      scout_run_id, user_id, provider_idempotency_key
    ) VALUES (NEW.id, NEW.user_id, 'civic/' || NEW.id::text || '/new-items')
    ON CONFLICT (scout_run_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER civic_run_alert_delivery_on_settlement
AFTER UPDATE OF status ON public.scout_runs
FOR EACH ROW EXECUTE FUNCTION public.seal_civic_run_alert_delivery();

CREATE OR REPLACE FUNCTION public.claim_civic_run_alert_delivery(
  p_run_id uuid, p_worker_id text, p_lease_seconds int DEFAULT 900
) RETURNS TABLE (
  delivery_id uuid, user_id uuid, provider_idempotency_key text,
  fencing_token bigint, needs_provider_submission boolean
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v public.civic_run_alert_deliveries%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.civic_run_alert_deliveries
   WHERE scout_run_id = p_run_id
     AND (state IN ('pending', 'failed') OR (state = 'sending' AND lease_expires_at < now())
          OR state = 'provider_accepted')
   FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.civic_run_alert_deliveries AS d
     SET state = 'sending', lease_owner = p_worker_id,
         lease_expires_at = now() + make_interval(secs => greatest(1, p_lease_seconds)),
         fencing_token = v.fencing_token + 1, updated_at = now()
   WHERE d.id = v.id
   RETURNING d.id, d.user_id, d.provider_idempotency_key,
             d.fencing_token, (v.state <> 'provider_accepted')
   INTO delivery_id, user_id, provider_idempotency_key, fencing_token, needs_provider_submission;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_civic_run_alert_provider_accepted(
  p_delivery_id uuid, p_worker_id text, p_fencing_token bigint, p_provider_id text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.civic_run_alert_deliveries SET state = 'provider_accepted',
    provider_id = coalesce(p_provider_id, provider_id), provider_accepted_at = now(), updated_at = now()
  WHERE id = p_delivery_id AND state = 'sending' AND lease_owner = p_worker_id
    AND fencing_token = p_fencing_token AND lease_expires_at > now();
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_civic_run_alert_delivery(
  p_delivery_id uuid, p_worker_id text, p_fencing_token bigint,
  p_state text, p_error text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_state NOT IN ('sent', 'failed') THEN RAISE EXCEPTION 'invalid alert final state'; END IF;
  UPDATE public.civic_run_alert_deliveries SET state = p_state, last_error = p_error,
    sent_at = CASE WHEN p_state = 'sent' THEN now() ELSE sent_at END,
    lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
  WHERE id = p_delivery_id AND state IN ('sending', 'provider_accepted')
    AND lease_owner = p_worker_id AND fencing_token = p_fencing_token;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_civic_run_alert_delivery(uuid, text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_civic_run_alert_provider_accepted(uuid, text, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_civic_run_alert_delivery(uuid, text, bigint, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_civic_run_alert_delivery(uuid, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_civic_run_alert_provider_accepted(uuid, text, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_civic_run_alert_delivery(uuid, text, bigint, text, text) TO service_role;
