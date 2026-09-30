BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(1);
CREATE FUNCTION pg_temp.assert_true(ok boolean, message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'assertion failed: %', message; END IF; END $$;
SELECT lives_ok($test$
DO $$
DECLARE
  uid uuid := gen_random_uuid(); sid uuid := gen_random_uuid(); snapshot uuid := gen_random_uuid();
  rid uuid; q record; item jsonb; result record;
  urls text[] := ARRAY['https://example.test/initial.pdf','https://example.test/empty.pdf'];
BEGIN
  INSERT INTO auth.users(id) VALUES(uid);
  INSERT INTO public.scouts(id,user_id,name,type,is_active,schedule_cron)
    VALUES(sid,uid,'First Civic run','civic',true,'0 8 * * 1');
  INSERT INTO public.civic_preview_snapshots(id,user_id,policy_version,tracked_urls,documents,expires_at)
    VALUES(snapshot,uid,'civic-accountability-v2',to_jsonb(urls),
      '[{"source_url":"https://example.test/initial.pdf"},{"source_url":"https://example.test/empty.pdf"}]',now()+interval '1 hour');
  PERFORM pg_temp.assert_true(public.enqueue_initial_civic_run(sid,uid,snapshot,urls)=2,'first import queues both reviewed documents');
  SELECT id INTO rid FROM public.scout_runs WHERE scout_id=sid;
  PERFORM pg_temp.assert_true(rid IS NOT NULL,'initial import has a real run');
  PERFORM pg_temp.assert_true((SELECT count(*)=2 FROM public.civic_extraction_queue WHERE scout_run_id=rid),'initial documents share the same run');
  PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.civic_run_alert_deliveries WHERE scout_run_id=rid),'preview and enqueue do not send an email');
  PERFORM pg_temp.assert_true(public.enqueue_initial_civic_run(sid,uid,snapshot,urls)=2,'enqueue response retry is idempotent');
  PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.scout_runs WHERE scout_id=sid),'enqueue retry cannot create another run');
  SELECT * INTO q FROM public.claim_civic_queue_item('initial-worker',rid,900,3);
  item := jsonb_build_object('p_user_id',uid,'p_scout_id',sid,'p_scout_run_id',rid,
    'p_statement','Council will complete the bridge by 2030-06-01.', 'p_statement_hash','initial-promise',
    'p_type','promise','p_source_type','civic_promise','p_scout_type','civic',
    'p_source_url',q.source_url,'p_normalized_source_url',q.source_url,
    'p_source_domain','example.test','p_entities','[]'::jsonb,'p_extracted_at',now(),
    'p_metadata',jsonb_build_object('civic_kind','promise','due_date','2030-06-01',
      'due_date_text','by 1 June 2030','date_confidence','high'));
  SELECT * INTO result FROM public.persist_civic_item(q.id,'initial-worker',item);
  PERFORM public.persist_civic_item(q.id,'initial-worker',item);
  PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.civic_run_alert_items WHERE scout_run_id=rid),'first stored promise creates one alert intent despite retry');
  PERFORM pg_temp.assert_true((SELECT due_date='2030-06-01'::date FROM public.promises WHERE unit_id=result.unit_id),'alert refers to a persisted deadline tracker');
  PERFORM public.finalize_civic_run_doc(q.id,'initial-worker',rid,1,0,NULL);
  PERFORM pg_temp.assert_true((SELECT status='running' FROM public.scout_runs WHERE id=rid),'first document waits for semantic-zero sibling');
  PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.civic_run_alert_deliveries WHERE scout_run_id=rid),'partial initial run has no sealed delivery');
  SELECT * INTO q FROM public.claim_civic_queue_item('initial-worker',rid,900,3);
  PERFORM public.finalize_civic_run_doc(q.id,'initial-worker',rid,0,0,NULL);
  PERFORM pg_temp.assert_true((SELECT status='success' AND notification_status='pending' FROM public.scout_runs WHERE id=rid),'last empty document does not suppress the first document promise');
  PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.civic_run_alert_deliveries WHERE scout_run_id=rid),'complete initial run seals exactly one saved-promises email');
END $$;
$test$, 'initial user import emails only stored promises after all documents settle, never preview candidates');
SELECT * FROM finish();
ROLLBACK;
