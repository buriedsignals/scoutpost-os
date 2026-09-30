BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(1);
CREATE FUNCTION pg_temp.assert_true(ok boolean, message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'assertion failed: %', message; END IF; END $$;
SELECT lives_ok($test$
DO $$
DECLARE
  uid uuid := gen_random_uuid(); sid uuid := gen_random_uuid();
  today_id uuid := gen_random_uuid(); overdue_id uuid := gen_random_uuid();
  next_id uuid := gen_random_uuid(); undated_id uuid := gen_random_uuid();
  first_claim record; second_claim record; recovered record;
BEGIN
  INSERT INTO auth.users(id) VALUES(uid);
  INSERT INTO public.scouts(id,user_id,name,type,is_active) VALUES(sid,uid,'Deadline boundaries','civic',false);
  INSERT INTO public.promises(id,user_id,scout_id,promise_text,source_url,due_date,date_confidence,status) VALUES
    (overdue_id,uid,sid,'Overdue audit','https://example.test/overdue','2030-05-31','high','in_progress'),
    (today_id,uid,sid,'Due-day bridge','https://example.test/today','2030-06-01','high','new'),
    (next_id,uid,sid,'Future library','https://example.test/future','2030-06-02','high','new'),
    (undated_id,uid,sid,'Undated legacy promise','https://example.test/undated',NULL,NULL,'new'),
    (gen_random_uuid(),uid,sid,'Fulfilled','https://example.test/fulfilled','2030-06-01','high','fulfilled'),
    (gen_random_uuid(),uid,sid,'Broken','https://example.test/broken','2030-06-01','high','broken');
  SELECT * INTO first_claim FROM public.claim_due_promise_reminders('first','2030-06-01',1,60);
  PERFORM pg_temp.assert_true(first_claim.promise_id=overdue_id,'overdue open promise catches up first');
  SELECT * INTO second_claim FROM public.claim_due_promise_reminders('second','2030-06-01',1,60);
  PERFORM pg_temp.assert_true(second_claim.promise_id=today_id,'live earlier lease must not starve due-day promise');
  PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.claim_due_promise_reminders('third','2030-06-01',100,60)),
    'future, undated, closed, and live-leased promises never notify');
  PERFORM public.finalize_due_promise_reminders('first',ARRAY[first_claim.delivery_id],false,'temporary provider failure');
  SELECT * INTO recovered FROM public.claim_due_promise_reminders('retry','2030-06-01',100,60);
  PERFORM pg_temp.assert_true(recovered.promise_id=overdue_id AND recovered.provider_idempotency_key=first_claim.provider_idempotency_key,
    'retry retains the exact deadline provider identity');
  PERFORM public.mark_due_promise_reminders_provider_accepted('retry',ARRAY[recovered.delivery_id],'provider-1');
  SELECT * INTO recovered FROM public.claim_due_promise_reminders('reconcile','2030-06-01',100,60);
  PERFORM pg_temp.assert_true(NOT recovered.needs_provider_submission,'accepted reminders do not resubmit');
  PERFORM public.finalize_due_promise_reminders('reconcile',ARRAY[recovered.delivery_id],true);
  PERFORM public.finalize_due_promise_reminders('second',ARRAY[second_claim.delivery_id],true);
  PERFORM pg_temp.assert_true((SELECT status='in_progress' AND due_notified_at IS NOT NULL FROM public.promises WHERE id=overdue_id),
    'delivery does not decide whether a promise was fulfilled');
  PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.claim_due_promise_reminders('repeat','2030-06-01',100,60)),
    'same deadline is delivered only once');
  INSERT INTO public.user_preferences(user_id,preferences) VALUES(uid,'{"email_notifications":false}')
    ON CONFLICT(user_id) DO UPDATE SET preferences=EXCLUDED.preferences;
  PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.claim_due_promise_reminders('disabled','2030-06-02',100,60)),
    'email opt-out does not consume deadline deliveries');
  UPDATE public.user_preferences SET preferences='{"email_notifications":true}' WHERE user_id=uid;
  SELECT * INTO recovered FROM public.claim_due_promise_reminders('reenabled','2030-06-02',100,60);
  PERFORM pg_temp.assert_true(recovered.promise_id=next_id,'re-enabled email catches the still-unnotified deadline');
END $$;
$test$, 'due-day, overdue, no-date, opt-out and lease boundaries retain exactly-once deadline intent');
SELECT * FROM finish();
ROLLBACK;
