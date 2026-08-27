-- Weekly operator-review-only abuse-risk audit. No automatic scout or account action.

BEGIN;

CREATE TABLE IF NOT EXISTS public.abuse_risk_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_key text NOT NULL UNIQUE CHECK (case_key ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scout_ids uuid[] NOT NULL DEFAULT '{}',
  rule_id text NOT NULL CHECK (rule_id IN (
    'AUP-PRIVATE-ACCESS',
    'AUP-STALKING-HARASSMENT-DOXXING',
    'AUP-COERCIVE-DISCRIMINATORY-SURVEILLANCE',
    'AUP-PROMPT-INJECTION',
    'AUP-RATE-LIMIT-ABUSE',
    'AUP-MISINFORMATION'
  )),
  severity text NOT NULL CHECK (severity IN ('medium', 'high')),
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array'),
  rationale text NOT NULL DEFAULT '',
  config_fingerprint text NOT NULL CHECK (config_fingerprint ~ '^[0-9a-f]{64}$'),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  prompt_version text NOT NULL,
  model text NOT NULL,
  state_transitions jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(state_transitions) = 'array'),
  review_history jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(review_history) = 'array'),
  notification_status text NOT NULL DEFAULT 'not_required'
    CHECK (notification_status IN ('not_required', 'pending', 'sent')),
  notified_at timestamptz,
  notification_provider_id text,
  disposition text CHECK (disposition IN ('confirmed', 'dismissed', 'deferred')),
  disposition_note text,
  disposition_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '180 days'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS abuse_risk_findings_review
  ON public.abuse_risk_findings (disposition, confidence, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS abuse_risk_findings_user
  ON public.abuse_risk_findings (user_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS abuse_risk_findings_expiry
  ON public.abuse_risk_findings (expires_at);

ALTER TABLE public.abuse_risk_findings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.abuse_risk_findings FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.abuse_risk_findings TO service_role;

CREATE OR REPLACE FUNCTION public.cleanup_abuse_risk_findings()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  WITH deleted AS (
    DELETE FROM public.abuse_risk_findings
     WHERE id IN (
       SELECT id
         FROM public.abuse_risk_findings
        WHERE expires_at < now()
        ORDER BY expires_at
        LIMIT 10000
     )
     RETURNING id
  )
  SELECT count(*)::integer INTO v_deleted FROM deleted;
  RETURN v_deleted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_abuse_risk_findings()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_abuse_risk_findings()
  TO service_role;

CREATE OR REPLACE FUNCTION public.record_abuse_risk_disposition(
  p_finding_id uuid,
  p_disposition text,
  p_note text DEFAULT NULL
)
RETURNS SETOF public.abuse_risk_findings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_disposition NOT IN ('confirmed', 'dismissed', 'deferred') THEN
    RAISE EXCEPTION 'invalid abuse finding disposition';
  END IF;

  RETURN QUERY
  UPDATE public.abuse_risk_findings
     SET disposition = p_disposition,
         disposition_note = nullif(left(trim(coalesce(p_note, '')), 2000), ''),
         disposition_at = now(),
         review_history = review_history || jsonb_build_array(jsonb_build_object(
           'at', now(),
           'disposition', p_disposition,
           'note', nullif(left(trim(coalesce(p_note, '')), 2000), '')
         )),
         updated_at = now()
   WHERE id = p_finding_id
   RETURNING *;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_abuse_risk_disposition(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_abuse_risk_disposition(uuid, text, text)
  TO service_role;

SELECT cron.unschedule('cleanup-abuse-risk-findings')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-abuse-risk-findings');
SELECT cron.schedule(
  'cleanup-abuse-risk-findings',
  '5 4 * * *',
  'SELECT public.cleanup_abuse_risk_findings()'
);

SELECT cron.unschedule('weekly-abuse-risk-audit')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'weekly-abuse-risk-audit');
SELECT cron.schedule(
  'weekly-abuse-risk-audit',
  '0 10 * * 1',
  $cmd$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/abuse-risk-audit',
      headers := jsonb_build_object(
        'X-Service-Key', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_service_key'),
        'Content-Type', 'application/json'
      ),
      body := '{"action":"run"}'::jsonb
    )
    WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
      AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key');
  $cmd$
);

COMMIT;
