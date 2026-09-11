-- Run against an isolated migrated database only. Fixtures and fault triggers
-- are rolled back. Exercises the real canonical RPC and table constraints.
BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(2);

CREATE FUNCTION pg_temp.assert_true(ok boolean, message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'assertion failed: %', message; END IF; END $$;
CREATE FUNCTION pg_temp.civic_fail_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('civic.test_fail', true) = TG_ARGV[0] AND
    (TG_ARGV[0] <> 'link' OR to_jsonb(NEW)->>'active_revision_id' IS NOT NULL) THEN
   RAISE EXCEPTION 'injected % failure', TG_ARGV[0];
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER civic_test_revision BEFORE INSERT ON public.promise_revisions
 FOR EACH ROW EXECUTE FUNCTION pg_temp.civic_fail_write('revision');
CREATE TRIGGER civic_test_link BEFORE UPDATE ON public.promises
 FOR EACH ROW EXECUTE FUNCTION pg_temp.civic_fail_write('link');
CREATE TRIGGER civic_test_alert BEFORE INSERT ON public.civic_run_alert_items
 FOR EACH ROW EXECUTE FUNCTION pg_temp.civic_fail_write('alert');
SELECT lives_ok($atomic_test$
DO $$
DECLARE
 uid uuid := gen_random_uuid(); sid uuid := gen_random_uuid(); rid uuid := gen_random_uuid();
 qid uuid := gen_random_uuid(); item jsonb; result record; retried record;
 phase text; pid uuid; revision uuid; original_status text;
BEGIN
 INSERT INTO auth.users(id) VALUES(uid);
 INSERT INTO public.scouts(id,user_id,name,type,is_active) VALUES(sid,uid,'Atomic persistence QA','civic',false);
 INSERT INTO public.scout_runs(id,user_id,scout_id,status) VALUES(rid,uid,sid,'running');
 INSERT INTO public.civic_extraction_queue(id,user_id,scout_id,scout_run_id,source_url,doc_kind,
   status,lease_owner,lease_expires_at,heartbeat_at)
 VALUES(qid,uid,sid,rid,'https://example.test/minutes.pdf','pdf','processing','qa-worker',now()+interval '1 hour',now());
 item := jsonb_build_object('p_user_id',uid,'p_scout_id',sid,'p_scout_run_id',rid,
   'p_statement','Council will complete the bridge by 2030-06-01.', 'p_statement_hash','qa-promise-hash',
   'p_type','promise','p_source_type','civic_promise','p_scout_type','civic',
   'p_source_url','https://example.test/minutes.pdf','p_normalized_source_url','https://example.test/minutes.pdf',
   'p_source_domain','example.test','p_entities','[]'::jsonb,'p_extracted_at',now(),
   'p_metadata',jsonb_build_object('civic_kind','promise','due_date','2030-06-01',
      'due_date_text','by 1 June 2030','date_confidence','high'));
 SET LOCAL ROLE service_role;
 FOREACH phase IN ARRAY ARRAY['revision','link','alert'] LOOP
   PERFORM set_config('civic.test_fail',phase,true);
   BEGIN
     PERFORM public.persist_civic_item(qid,'qa-worker',item);
     RAISE EXCEPTION 'failure injection did not fire';
   EXCEPTION WHEN OTHERS THEN
     IF SQLERRM NOT LIKE 'injected % failure' THEN RAISE; END IF;
   END;
   PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.information_units WHERE user_id=uid), phase||' rolls back canonical');
   PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.unit_occurrences WHERE user_id=uid), phase||' rolls back occurrence');
   PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.promises WHERE user_id=uid), phase||' rolls back tracker');
   PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.promise_revisions WHERE user_id=uid), phase||' rolls back revision');
   PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.civic_run_alert_items WHERE user_id=uid), phase||' rolls back alert');
 END LOOP;
 PERFORM set_config('civic.test_fail','',true);
 SELECT * INTO result FROM public.persist_civic_item(qid,'qa-worker',item);
 SELECT * INTO retried FROM public.persist_civic_item(qid,'qa-worker',item || jsonb_build_object('p_extracted_at',now()+interval '1 second'));
 PERFORM pg_temp.assert_true(result.created_canonical AND retried.created_canonical AND result.unit_id=retried.unit_id,'lost response retry retains original created result');
 PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.unit_occurrences WHERE user_id=uid),'one occurrence');
 PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.civic_run_alert_items WHERE user_id=uid),'one alert');
 SELECT id,active_revision_id INTO pid,revision FROM public.promises WHERE user_id=uid;
 PERFORM pg_temp.assert_true(revision IS NOT NULL,'revision linked');
 UPDATE public.promises SET status='fulfilled' WHERE id=pid;
 SELECT * INTO retried FROM public.persist_civic_item(qid,'qa-worker',item);
 PERFORM pg_temp.assert_true((SELECT status='fulfilled' AND active_revision_id=revision FROM public.promises WHERE id=pid),'editorial state preserved');
 BEGIN
   PERFORM public.persist_civic_item(qid,'qa-worker',item || '{"p_statement":"Changed promise"}'::jsonb);
   RAISE EXCEPTION 'changed retry accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'Civic retry changed the accepted item' THEN RAISE; END IF; END;
 BEGIN
   PERFORM public.persist_civic_item(qid,'wrong-worker',item);
   RAISE EXCEPTION 'foreign worker accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'Civic item persistence requires an active owned queue lease' THEN RAISE; END IF; END;
 -- Same statement through another queue cannot auto-repair a legacy revision.
 UPDATE public.promises SET active_revision_id=NULL WHERE id=pid;
 DELETE FROM public.civic_queue_item_results WHERE queue_id=qid;
 BEGIN
   PERFORM public.persist_civic_item(qid,'qa-worker',item);
   RAISE EXCEPTION 'ambiguous tracker auto-repaired';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'Existing Civic tracker needs an explicit revision repair' THEN RAISE; END IF; END;
 PERFORM pg_temp.assert_true((SELECT status='fulfilled' AND active_revision_id IS NULL FROM public.promises WHERE id=pid),'legacy state unchanged');
 UPDATE public.information_units SET deleted_at=now() WHERE id=result.unit_id;
 BEGIN
   PERFORM public.persist_civic_item(qid,'qa-worker',item);
   RAISE EXCEPTION 'deleted canonical accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'Civic extraction matched a deleted canonical item' THEN RAISE; END IF; END;
 PERFORM pg_temp.assert_true((SELECT deleted_at IS NOT NULL FROM public.information_units WHERE id=result.unit_id),'deletion retained');
 -- An adopted decision creates canonical+occurrence+result without a tracker or alert.
 item := item || jsonb_build_object('p_type','fact','p_source_type','scout','p_statement_hash','qa-decision-hash',
   'p_statement','Council adopted the transport budget.', 'p_metadata',jsonb_build_object('civic_kind','decision'));
 SELECT * INTO result FROM public.persist_civic_item(qid,'qa-worker',item);
 PERFORM pg_temp.assert_true(result.created_canonical,'decision stored');
 PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.promises WHERE user_id=uid),'decision has no tracker');
 PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.civic_run_alert_items WHERE user_id=uid),'decision has no alert');
 BEGIN
   PERFORM public.persist_civic_item(qid,'qa-worker',item || jsonb_build_object('p_user_id',gen_random_uuid()));
   RAISE EXCEPTION 'foreign owner accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'Civic item provenance does not match queue' THEN RAISE; END IF; END;
 PERFORM pg_temp.assert_true(public.finalize_civic_run_doc(qid,'qa-worker',rid,
   (SELECT count(*)::int FROM public.civic_queue_item_results WHERE queue_id=qid AND created_canonical),0,NULL), 'document finalizes');
 PERFORM pg_temp.assert_true(NOT public.finalize_civic_run_doc(qid,'qa-worker',rid,1,0,NULL),'document finalizes once');
 PERFORM pg_temp.assert_true((SELECT units_created_count=1 FROM public.scout_runs WHERE id=rid),'ledger drives one final count');
 PERFORM pg_temp.assert_true(NOT has_function_privilege('anon','public.persist_civic_item(uuid,text,jsonb)','EXECUTE'),'anon denied');
 PERFORM pg_temp.assert_true(NOT has_function_privilege('authenticated','public.persist_civic_item(uuid,text,jsonb)','EXECUTE'),'authenticated denied');
 RAISE NOTICE 'PASS: rollback at revision/link/alert, retry counts, state/deletion preservation, decision routing, service-only RPC';
END $$;
RESET ROLE;
$atomic_test$, 'Civic item persistence rolls back partial writes and preserves retry, tenancy and deletion invariants');

SELECT lives_ok($promotion_test$
DO $$
DECLARE
 uid uuid := gen_random_uuid(); sid uuid := gen_random_uuid(); origin uuid := gen_random_uuid();
 rid uuid := gen_random_uuid(); qid uuid := gen_random_uuid(); item jsonb;
 original record; result record; source_kind text; pid uuid;
BEGIN
 INSERT INTO auth.users(id) VALUES(uid);
 INSERT INTO public.scouts(id,user_id,name,type,is_active) VALUES
   (sid,uid,'Civic promotion QA','civic',false), (origin,uid,'Original Page QA','web',false);
 INSERT INTO public.scout_runs(id,user_id,scout_id,status) VALUES(rid,uid,sid,'running');
 INSERT INTO public.civic_extraction_queue(id,user_id,scout_id,scout_run_id,source_url,doc_kind,
   status,lease_owner,lease_expires_at,heartbeat_at)
 VALUES(qid,uid,sid,rid,'https://example.test/promotion.pdf','pdf','processing','qa-worker',now()+interval '1 hour',now());
 SET LOCAL ROLE service_role;
 FOREACH source_kind IN ARRAY ARRAY['web','beat'] LOOP
   SELECT * INTO original FROM public.upsert_canonical_unit_v2(
     p_user_id=>uid, p_statement=>'Council will build the '||source_kind||' bridge.', p_type=>'fact',
     p_source_url=>'https://news.test/'||source_kind, p_normalized_source_url=>'https://news.test/'||source_kind,
     p_statement_hash=>'promotion-'||source_kind, p_scout_id=>origin, p_scout_type=>source_kind);
   item := jsonb_build_object('p_user_id',uid,'p_scout_id',sid,'p_scout_run_id',rid,
     'p_statement','Council will build the '||source_kind||' bridge.', 'p_statement_hash','promotion-'||source_kind,
     'p_type','promise','p_source_type','civic_promise','p_scout_type','civic',
     'p_source_url','https://example.test/promotion.pdf','p_normalized_source_url','https://example.test/promotion.pdf',
     'p_source_domain','example.test','p_entities','[]'::jsonb,'p_extracted_at',now(),
     'p_metadata',jsonb_build_object('civic_kind','promise','due_date','2030-06-01',
       'due_date_text','by June 2030','date_confidence','high'));
   SELECT * INTO result FROM public.persist_civic_item(qid,'qa-worker',item);
   PERFORM pg_temp.assert_true(result.unit_id=original.unit_id AND NOT result.created_canonical AND result.merged_existing,'cross-scout match retains canonical');
   PERFORM pg_temp.assert_true((SELECT scout_type=source_kind AND scout_id=origin AND type='promise' FROM public.information_units WHERE id=result.unit_id),'original provenance preserved during promotion');
   SELECT id INTO pid FROM public.promises WHERE unit_id=result.unit_id AND user_id=uid;
   PERFORM pg_temp.assert_true((SELECT active_revision_id IS NOT NULL AND scout_id=sid FROM public.promises WHERE id=pid),'promotion creates linked tracker');
   PERFORM pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.civic_run_alert_items WHERE unit_id=result.unit_id),'merge never sends new-canonical alert');
   -- A missing tracker after prior Civic evidence is ambiguous, even though
   -- the canonical row still retains its original Page/Beat provenance.
   DELETE FROM public.promises WHERE id=pid;
   DELETE FROM public.civic_queue_item_results WHERE queue_id=qid AND statement_hash='promotion-'||source_kind;
   BEGIN
     PERFORM public.persist_civic_item(qid,'qa-worker',item);
     RAISE EXCEPTION 'removed tracker recreated';
   EXCEPTION WHEN OTHERS THEN
     IF SQLERRM <> 'Existing Civic canonical item needs an explicit tracker repair' THEN RAISE; END IF;
   END;
 END LOOP;
 RAISE NOTICE 'PASS: Page/Beat promotion preserves identity, links tracker, suppresses new alert, retains removed-tracker boundary';
END $$;
RESET ROLE;
$promotion_test$, 'Page/Beat promotion preserves identity and does not restore removed trackers');

SELECT * FROM finish();
ROLLBACK;
