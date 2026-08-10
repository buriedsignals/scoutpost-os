-- Repair is an exact-target, operator-approved workflow; a queue row cannot
-- become a general-purpose historical re-extraction job.
CREATE TABLE public.civic_repair_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  policy_version text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'applied', 'cancelled')),
  operator_id uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.civic_repair_batch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.civic_repair_batches(id) ON DELETE CASCADE,
  target_promise_id uuid REFERENCES public.promises(id),
  target_unit_id uuid REFERENCES public.information_units(id),
  expected_content_sha256 text NOT NULL,
  proposed_classification text NOT NULL CHECK (proposed_classification IN ('promise', 'decision', 'rejected', 'unresolved')),
  prior_classification text,
  source_time_basis timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'applied', 'unresolved')),
  UNIQUE (batch_id, target_promise_id),
  CHECK (target_promise_id IS NOT NULL OR target_unit_id IS NOT NULL)
);
ALTER TABLE public.civic_extraction_queue
  ADD COLUMN IF NOT EXISTS repair_batch_id uuid REFERENCES public.civic_repair_batches(id),
  ADD COLUMN IF NOT EXISTS repair_batch_item_id uuid REFERENCES public.civic_repair_batch_items(id);
ALTER TABLE public.civic_repair_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.civic_repair_batch_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.civic_repair_batches, public.civic_repair_batch_items FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.civic_repair_batches, public.civic_repair_batch_items TO service_role;

CREATE OR REPLACE FUNCTION public.enforce_civic_repair_queue_target()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_valid boolean;
BEGIN
  IF NEW.ingestion_mode <> 'repair' THEN RETURN NEW; END IF;
  IF NEW.repair_batch_id IS NULL OR NEW.repair_batch_item_id IS NULL THEN
    RAISE EXCEPTION 'repair queue rows require an approved batch and exact item';
  END IF;
  SELECT EXISTS (
    SELECT 1
      FROM public.civic_repair_batches b
      JOIN public.civic_repair_batch_items i ON i.batch_id = b.id
     WHERE b.id = NEW.repair_batch_id AND i.id = NEW.repair_batch_item_id
       AND b.user_id = NEW.user_id AND b.status = 'approved' AND i.status = 'approved'
       AND (
         (i.target_promise_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM public.promises p
            WHERE p.id = i.target_promise_id AND p.user_id = NEW.user_id AND p.scout_id = NEW.scout_id
         )) OR
         (i.target_unit_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM public.information_units u
            WHERE u.id = i.target_unit_id AND u.user_id = NEW.user_id
         ))
       )
  ) INTO v_valid;
  IF NOT v_valid THEN
    RAISE EXCEPTION 'repair queue target is not an approved tenant-owned ledger item';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER civic_repair_queue_target_guard
BEFORE INSERT OR UPDATE OF ingestion_mode, repair_batch_id, repair_batch_item_id
ON public.civic_extraction_queue
FOR EACH ROW EXECUTE FUNCTION public.enforce_civic_repair_queue_target();
