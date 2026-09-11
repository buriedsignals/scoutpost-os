BEGIN;
SET LOCAL search_path=public,extensions;
SELECT plan(1);
CREATE FUNCTION pg_temp.backfill_assert(ok boolean,message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'assertion failed: %',message; END IF; END $$;
SELECT lives_ok($test$
DO $$
DECLARE uid uuid:=gen_random_uuid(); sid uuid:=gen_random_uuid(); rid uuid:=gen_random_uuid();
 other_id uuid:=gen_random_uuid(); qid uuid; capture uuid; snapshot jsonb; docs jsonb; hash text:=repeat('a',64);
 item jsonb; outcome record;
BEGIN
 INSERT INTO auth.users(id) VALUES(uid),(other_id);
 INSERT INTO public.scouts(id,user_id,name,type,is_active,schedule_cron,tracked_urls,processed_pdf_urls)
 VALUES(sid,uid,'Backfill integration','civic',true,'3 14 * * 5',ARRAY['https://example.test/list'],ARRAY['https://example.test/prior.pdf']);
 SELECT jsonb_build_object('tracked_urls',tracked_urls,'criteria',criteria,'preferred_language',preferred_language,'project_id',project_id)
 INTO snapshot FROM public.scouts WHERE id=sid;
 docs:=jsonb_build_array(jsonb_build_object('source_url','https://example.test/minutes.pdf','listing_url','https://example.test/list',
   'document_date','2026-08-01','doc_kind','pdf','title','Approved minutes','markdown','Council adopted the bridge plan.',
   'content_sha256',encode(extensions.digest('Council adopted the bridge plan.','sha256'),'hex')));
 SET LOCAL ROLE service_role;
 PERFORM pg_temp.backfill_assert(NOT has_function_privilege('authenticated','public.enqueue_civic_backfill(uuid,uuid,uuid,text,jsonb,jsonb)','EXECUTE'),'private RPC');
 BEGIN
   PERFORM public.enqueue_civic_backfill(rid,other_id,sid,hash,snapshot,docs);
   RAISE EXCEPTION 'foreign owner accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%ownership/type mismatch%' THEN RAISE; END IF; END;
 BEGIN
   PERFORM public.enqueue_civic_backfill(rid,uid,sid,hash,snapshot,jsonb_set(docs,'{0,content_sha256}',to_jsonb(repeat('b',64))));
   RAISE EXCEPTION 'bad hash accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%hash mismatch%' THEN RAISE; END IF; END;
 BEGIN
   PERFORM public.enqueue_civic_backfill(rid,uid,sid,hash,jsonb_set(snapshot,'{criteria}','"changed"'),docs);
   RAISE EXCEPTION 'changed Scout accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%configuration changed%' THEN RAISE; END IF; END;
 BEGIN
   PERFORM public.enqueue_civic_backfill(rid,uid,sid,hash,snapshot,(SELECT jsonb_agg(docs->0) FROM generate_series(1,11)));
   RAISE EXCEPTION 'oversized batch accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%1-10 documents%' THEN RAISE; END IF; END;
 PERFORM public.enqueue_civic_backfill(rid,uid,sid,hash,snapshot,docs);
 PERFORM pg_temp.backfill_assert(public.enqueue_civic_backfill(rid,uid,sid,hash,snapshot,docs)=rid,'same run resumes');
 PERFORM pg_temp.backfill_assert((SELECT count(*)=1 FROM public.civic_extraction_queue WHERE scout_run_id=rid),'no duplicate queue');
 BEGIN
   PERFORM public.enqueue_civic_backfill(rid,uid,sid,repeat('c',64),snapshot,docs);
   RAISE EXCEPTION 'changed manifest accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%identity mismatch%' THEN RAISE; END IF; END;
 SELECT id,raw_capture_id INTO qid,capture FROM public.civic_extraction_queue WHERE scout_run_id=rid;
 PERFORM pg_temp.backfill_assert((SELECT ingestion_mode='backfill' AND semantics_snapshot->>'content_sha256'=docs->0->>'content_sha256'
   FROM public.civic_extraction_queue WHERE id=qid),'pinned queue mode/hash');
 PERFORM pg_temp.backfill_assert((SELECT user_id=uid AND scout_id=sid AND scout_run_id=rid AND expires_at>now()+interval '29 days'
   AND content_md=docs->0->>'markdown' FROM public.raw_captures WHERE id=capture),'owned pinned capture TTL');
 BEGIN
   INSERT INTO public.civic_extraction_queue(user_id,scout_id,source_url,doc_kind) VALUES(uid,sid,'https://example.test/other.pdf','pdf');
   RAISE EXCEPTION 'concurrent scheduled queue accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%other active queue work%' THEN RAISE; END IF; END;
 PERFORM public.claim_civic_queue_item('backfill-test',rid,3600,3);
 item:=jsonb_build_object('p_user_id',uid,'p_scout_id',sid,'p_scout_run_id',rid,'p_statement','Council adopted the bridge plan.',
   'p_statement_hash','backfill-decision-hash','p_type','fact','p_source_type','scout','p_scout_type','civic',
   'p_source_url','https://example.test/minutes.pdf','p_normalized_source_url','https://example.test/minutes.pdf',
   'p_source_domain','example.test','p_entities','[]'::jsonb,'p_extracted_at',now(),'p_metadata',jsonb_build_object('civic_kind','decision'));
 SELECT * INTO outcome FROM public.persist_civic_item(qid,'backfill-test',item);
 PERFORM pg_temp.backfill_assert(outcome.created_canonical,'backfill uses atomic persistence');
 item:=item||jsonb_build_object('p_statement','Council will build the bridge by 2030-06-01.',
   'p_statement_hash','backfill-promise-hash','p_type','promise','p_source_type','civic_promise',
   'p_metadata',jsonb_build_object('civic_kind','promise','due_date','2030-06-01',
   'due_date_text','by 1 June 2030','date_confidence','high'));
 SELECT * INTO outcome FROM public.persist_civic_item(qid,'backfill-test',item);
 PERFORM pg_temp.backfill_assert(outcome.created_canonical AND EXISTS(SELECT 1 FROM public.promises
   WHERE unit_id=outcome.unit_id AND active_revision_id IS NOT NULL),'backfill promise tracker and revision');
 PERFORM pg_temp.backfill_assert(public.finalize_civic_run_doc(qid,'backfill-test',rid,2,0,capture),'backfill settles');
 PERFORM pg_temp.backfill_assert((SELECT status='success' AND notification_status='not_applicable' AND units_created_count=2 FROM public.scout_runs WHERE id=rid),'settled counts without notification');
 PERFORM pg_temp.backfill_assert(NOT EXISTS(SELECT 1 FROM public.civic_run_alert_items WHERE scout_run_id=rid)
   AND NOT EXISTS(SELECT 1 FROM public.civic_run_alert_deliveries WHERE scout_run_id=rid),'no historical alert ledger');
 PERFORM pg_temp.backfill_assert((SELECT processed_pdf_urls=ARRAY['https://example.test/prior.pdf'] FROM public.scouts WHERE id=sid),'live processed URLs preserved');
 BEGIN
   PERFORM public.enqueue_civic_backfill(gen_random_uuid(),uid,sid,hash,snapshot,docs);
   RAISE EXCEPTION 'duplicate document accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 UPDATE public.scouts SET is_active=false WHERE id=sid;
 BEGIN
   PERFORM public.enqueue_civic_backfill(gen_random_uuid(),uid,sid,hash,snapshot,docs);
   RAISE EXCEPTION 'paused Scout accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%paused%' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
$test$,'Bounded backfill ownership, retry, pinned capture, persistence, settlement and no notification/baseline mutation');
SELECT * FROM finish();
ROLLBACK;
