-- Immutable official-source deadline history.  A tracker retains its human
-- lifecycle state while a later, explicitly supported amendment can point it
-- at a new active revision.
CREATE TABLE public.promise_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promise_id uuid NOT NULL REFERENCES public.promises(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  due_date date NOT NULL,
  date_confidence text NOT NULL CHECK (date_confidence IN ('high', 'medium', 'low')),
  due_date_text text NOT NULL,
  source_url text NOT NULL,
  context text NOT NULL,
  previous_revision_id uuid REFERENCES public.promise_revisions(id) ON DELETE RESTRICT,
  amendment_reason text NOT NULL DEFAULT 'initial'
    CHECK (amendment_reason IN ('initial', 'official_amendment')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.promises
  ADD COLUMN IF NOT EXISTS active_revision_id uuid
    REFERENCES public.promise_revisions(id) ON DELETE SET NULL;

CREATE INDEX promise_revisions_promise_created_idx
  ON public.promise_revisions (promise_id, created_at DESC);

ALTER TABLE public.promise_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.promise_revisions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.promise_revisions TO service_role;
