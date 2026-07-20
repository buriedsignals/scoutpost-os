-- Signed, idempotent Resend delivery-event reconciliation.

BEGIN;

ALTER TABLE public.scout_runs
  ADD COLUMN notification_event_at timestamptz,
  ADD COLUMN notification_delivery_detail text;

ALTER TABLE public.scout_runs
  DROP CONSTRAINT IF EXISTS scout_runs_notification_status_check;
ALTER TABLE public.scout_runs
  ADD CONSTRAINT scout_runs_notification_status_check CHECK (
    notification_status IS NULL OR notification_status IN (
      'not_applicable', 'pending', 'sent', 'delivered', 'delayed',
      'bounced', 'suppressed', 'complained', 'skipped', 'failed'
    )
  );

ALTER TABLE public.scout_run_events
  DROP CONSTRAINT IF EXISTS scout_run_events_notification_status_check;
ALTER TABLE public.scout_run_events
  ADD CONSTRAINT scout_run_events_notification_status_check CHECK (
    notification_status IS NULL OR notification_status IN (
      'not_applicable', 'pending', 'sent', 'delivered', 'delayed',
      'bounced', 'suppressed', 'complained', 'skipped', 'failed'
    )
  );

CREATE TABLE public.email_delivery_events (
  svix_id text PRIMARY KEY,
  provider_email_id text NOT NULL,
  scout_run_id uuid REFERENCES public.scout_runs(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  delivery_status text,
  event_created_at timestamptz NOT NULL,
  recipient_count int NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  CONSTRAINT email_delivery_events_status_check CHECK (
    delivery_status IS NULL OR delivery_status IN (
      'sent', 'delivered', 'delayed', 'bounced', 'suppressed',
      'complained', 'failed'
    )
  )
);

CREATE INDEX email_delivery_events_provider
  ON public.email_delivery_events(provider_email_id, event_created_at DESC);
CREATE INDEX email_delivery_events_run
  ON public.email_delivery_events(scout_run_id, event_created_at DESC)
  WHERE scout_run_id IS NOT NULL;
CREATE INDEX email_delivery_events_expires
  ON public.email_delivery_events(expires_at);

ALTER TABLE public.email_delivery_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_delivery_events FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_resend_delivery_event(
  p_svix_id text,
  p_provider_email_id text,
  p_event_type text,
  p_delivery_status text,
  p_event_created_at timestamptz,
  p_recipient_count int,
  p_reason text,
  p_details jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (inserted boolean, matched_run_id uuid, reconciled boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted boolean := false;
  v_run_id uuid;
  v_rows int := 0;
BEGIN
  IF length(trim(COALESCE(p_svix_id, ''))) = 0 THEN
    RAISE EXCEPTION 'svix id is required';
  END IF;
  IF length(trim(COALESCE(p_provider_email_id, ''))) = 0 THEN
    RAISE EXCEPTION 'provider email id is required';
  END IF;
  IF p_delivery_status IS NOT NULL AND p_delivery_status NOT IN (
    'sent', 'delivered', 'delayed', 'bounced', 'suppressed',
    'complained', 'failed'
  ) THEN
    RAISE EXCEPTION 'invalid delivery status';
  END IF;

  INSERT INTO public.email_delivery_events (
    svix_id, provider_email_id, event_type, delivery_status,
    event_created_at, recipient_count, reason, details
  ) VALUES (
    p_svix_id,
    p_provider_email_id,
    left(p_event_type, 100),
    p_delivery_status,
    p_event_created_at,
    GREATEST(0, COALESCE(p_recipient_count, 0)),
    left(p_reason, 1000),
    COALESCE(p_details, '{}'::jsonb)
  )
  ON CONFLICT (svix_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_inserted := v_rows = 1;

  SELECT id INTO v_run_id
    FROM public.scout_runs
   WHERE notification_provider_id = p_provider_email_id
   ORDER BY started_at DESC
   LIMIT 1;

  IF v_inserted AND v_run_id IS NOT NULL THEN
    UPDATE public.email_delivery_events
       SET scout_run_id = v_run_id
     WHERE svix_id = p_svix_id;

    IF p_delivery_status IS NOT NULL THEN
      UPDATE public.scout_runs
         SET notification_status = p_delivery_status,
             notification_reason = left(p_reason, 1000),
             notification_event_at = p_event_created_at,
             notification_delivery_detail = left(p_reason, 2000)
       WHERE id = v_run_id
         AND (
           notification_event_at IS NULL
           OR notification_event_at <= p_event_created_at
         );
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 1 THEN
        INSERT INTO public.scout_run_events (
          scout_run_id, scout_id, user_id, stage, status,
          notification_status, message, metadata
        )
        SELECT id, scout_id, user_id, 'notify', status,
               p_delivery_status, left(p_reason, 2000),
               jsonb_build_object(
                 'event_type', p_event_type,
                 'provider_email_id', p_provider_email_id,
                 'event_created_at', p_event_created_at
               )
          FROM public.scout_runs
         WHERE id = v_run_id;
      END IF;
    ELSE
      v_rows := 0;
    END IF;
  ELSE
    v_rows := 0;
  END IF;

  inserted := v_inserted;
  matched_run_id := v_run_id;
  reconciled := v_rows = 1;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_email_delivery_events()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  DELETE FROM public.email_delivery_events
   WHERE svix_id IN (
     SELECT svix_id
       FROM public.email_delivery_events
      WHERE expires_at < now()
      LIMIT 10000
   );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- A delivery event may beat the worker's notification_provider_id update.
-- Reconcile any already-stored event when that provider ID becomes visible.
CREATE OR REPLACE FUNCTION public.reconcile_stored_resend_events_for_run()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event public.email_delivery_events%ROWTYPE;
BEGIN
  IF NEW.notification_provider_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.notification_provider_id IS NOT DISTINCT FROM OLD.notification_provider_id THEN
      RETURN NEW;
    END IF;
  END IF;

  UPDATE public.email_delivery_events
     SET scout_run_id = NEW.id
   WHERE provider_email_id = NEW.notification_provider_id
     AND scout_run_id IS NULL;

  SELECT * INTO v_event
    FROM public.email_delivery_events
   WHERE provider_email_id = NEW.notification_provider_id
     AND delivery_status IS NOT NULL
   ORDER BY event_created_at DESC, received_at DESC
   LIMIT 1;

  IF FOUND AND (
    NEW.notification_event_at IS NULL
    OR NEW.notification_event_at <= v_event.event_created_at
  ) THEN
    UPDATE public.scout_runs
       SET notification_status = v_event.delivery_status,
           notification_reason = left(v_event.reason, 1000),
           notification_event_at = v_event.event_created_at,
           notification_delivery_detail = left(v_event.reason, 2000)
     WHERE id = NEW.id;

    INSERT INTO public.scout_run_events (
      scout_run_id, scout_id, user_id, stage, status,
      notification_status, message, metadata
    ) VALUES (
      NEW.id, NEW.scout_id, NEW.user_id, 'notify', NEW.status,
      v_event.delivery_status, left(v_event.reason, 2000),
      jsonb_build_object(
        'event_type', v_event.event_type,
        'provider_email_id', NEW.notification_provider_id,
        'event_created_at', v_event.event_created_at
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reconcile_stored_resend_events ON public.scout_runs;
CREATE TRIGGER reconcile_stored_resend_events
  AFTER INSERT OR UPDATE ON public.scout_runs
  FOR EACH ROW EXECUTE FUNCTION public.reconcile_stored_resend_events_for_run();

REVOKE ALL ON FUNCTION public.record_resend_delivery_event(text, text, text, text, timestamptz, int, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_email_delivery_events()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_stored_resend_events_for_run()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_resend_delivery_event(text, text, text, text, timestamptz, int, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_email_delivery_events() TO service_role;

DO $$
BEGIN
  PERFORM cron.unschedule('cleanup-email-delivery-events')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-email-delivery-events');
  PERFORM cron.schedule(
    'cleanup-email-delivery-events',
    '50 3 * * *',
    'SELECT public.cleanup_email_delivery_events()'
  );
END;
$$;

COMMIT;
