-- Disposable baseline tests only. These fixture additions are NOT migrations.
ALTER TABLE public.sentlog_projects ADD COLUMN IF NOT EXISTS client_key text;
ALTER TABLE public.sentlog_project_snapshots ADD COLUMN IF NOT EXISTS owner_id uuid;
ALTER TABLE public.sentlog_project_snapshots ADD COLUMN IF NOT EXISTS payload jsonb;

CREATE OR REPLACE FUNCTION public.baseline_test_record(rid text,is_deleted boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=''
AS $fn$
 SELECT pg_catalog.jsonb_build_object('id',rid,'memo','comment:'||rid,'member','pier',
  'photos',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id','photo:'||rid,'size',3,'sha256',repeat('1',64))),
  'collab',pg_catalog.jsonb_build_object('version',1,
   'comments',pg_catalog.jsonb_build_object('c',pg_catalog.jsonb_build_object('order',0,
    'revisions',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id','comment-root:'||rid,
      'parents','[]'::jsonb,'actor',pg_catalog.jsonb_build_object('deviceId',null,'deviceName','fixture'),
      'at',0,'text','comment:'||rid,'deleted',false)))),
   'fields',pg_catalog.jsonb_build_object('member',pg_catalog.jsonb_build_object(
    'revisions',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id','member-root:'||rid,
      'parents','[]'::jsonb,'actor',pg_catalog.jsonb_build_object('deviceId',null,'deviceName','fixture'),
      'at',0,'value','pier')))),
   'photos',pg_catalog.jsonb_build_object('photo:'||rid,pg_catalog.jsonb_build_object(
    'revisions',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id','photo-root:'||rid,
      'parents','[]'::jsonb,'actor',pg_catalog.jsonb_build_object('deviceId',null,'deviceName','fixture'),
      'at',0,'value',pg_catalog.jsonb_build_object('id','photo:'||rid,'size',3,'sha256',repeat('1',64)),'deleted',false)))),
   'deletion',pg_catalog.jsonb_build_object('revisions',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'id','deletion-root:'||rid,'parents','[]'::jsonb,
    'actor',pg_catalog.jsonb_build_object('deviceId',null,'deviceName','fixture'),
    'at',0,'deleted',is_deleted,'observed',pg_catalog.jsonb_build_array('comment-root:'||rid,'member-root:'||rid,'photo-root:'||rid))))))
$fn$;
CREATE OR REPLACE FUNCTION public.baseline_test_payload(client_id text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=''
AS $fn$
 SELECT pg_catalog.jsonb_build_object('project',pg_catalog.jsonb_build_object(
  'id',client_id,'name','baseline fixture','collaborationVersion',1,'drawings',
   '[{"id":"drawing:1"},{"id":"drawing:2"}]'::jsonb),
  'drawings',pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('meta',pg_catalog.jsonb_build_object('id','drawing:1','pdfFileId','drawing-pdf'),
      'state',pg_catalog.jsonb_build_object('rotation',90,'scale',0.01,
        'shapes',pg_catalog.jsonb_build_array(public.baseline_test_record('record:1')),
        'collabDeletedRecords',pg_catalog.jsonb_build_array(public.baseline_test_record('deleted:1',true)))),
    pg_catalog.jsonb_build_object('meta',pg_catalog.jsonb_build_object('id','drawing:2'),
      'state',pg_catalog.jsonb_build_object('shapes',pg_catalog.jsonb_build_array(public.baseline_test_record('record:1'))))))
$fn$;
INSERT INTO public.sentlog_projects(id,owner_id,status,client_key)
 SELECT ('77000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,'active','baseline-client-'||n
 FROM pg_catalog.generate_series(1,12) n;
INSERT INTO public.sentlog_project_snapshots(project_id,owner_id,revision,payload)
 SELECT id,owner_id,10,public.baseline_test_payload(client_key)
 FROM public.sentlog_projects WHERE client_key LIKE 'baseline-client-%';

-- Good first record then malformed tombstone: a two-record batch must roll
-- back its first write; a previously committed one-record batch must survive.
UPDATE public.sentlog_project_snapshots SET payload=pg_catalog.jsonb_set(payload,
 '{drawings,0,state,collabDeletedRecords,0,collab,comments,c,revisions,0,parents}','["absent-parent"]'::jsonb)
 WHERE project_id='77000000-0000-4000-8000-000000000003';
-- ID collision between an ordinary record and a tombstone.
UPDATE public.sentlog_project_snapshots SET payload=pg_catalog.jsonb_set(payload,
 '{drawings,0,state,collabDeletedRecords}',pg_catalog.jsonb_build_array(public.baseline_test_record('record:1')))
 WHERE project_id='77000000-0000-4000-8000-000000000004';
-- Pre-collaboration snapshots must never receive made-up server history.
UPDATE public.sentlog_project_snapshots SET payload=payload#-'{project,collaborationVersion}'
 WHERE project_id='77000000-0000-4000-8000-000000000005';
-- Valid empty snapshot.
UPDATE public.sentlog_project_snapshots SET payload=pg_catalog.jsonb_set(
 pg_catalog.jsonb_set(payload,'{project,drawings}','[]'::jsonb),'{drawings}','[]'::jsonb)
 WHERE project_id='77000000-0000-4000-8000-000000000006';
-- Incomplete drawing state must not silently become an empty drawing.
UPDATE public.sentlog_project_snapshots SET payload=payload#-'{drawings,0,state,shapes}'
 WHERE project_id='77000000-0000-4000-8000-000000000007';
-- Unsupported large single-record history must keep delta disabled.
UPDATE public.sentlog_project_snapshots SET payload=pg_catalog.jsonb_set(payload,
 '{drawings,0,state,shapes,0,collab,comments,c,revisions,0,text}',pg_catalog.to_jsonb(repeat('x',270000)))
 WHERE project_id='77000000-0000-4000-8000-000000000008';

CREATE TABLE public.baseline_test_results(label text PRIMARY KEY);
GRANT INSERT,SELECT ON public.baseline_test_results TO authenticated;
CREATE OR REPLACE FUNCTION public.baseline_assert(ok boolean,label text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'baseline assertion failed: %',label; END IF;
 INSERT INTO public.baseline_test_results VALUES(label);
END $fn$;
CREATE OR REPLACE FUNCTION public.baseline_expect_error(sql_command text,wanted_state text,needle text,label text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE actual_state text; actual_message text;
BEGIN
 BEGIN EXECUTE sql_command;
 EXCEPTION WHEN OTHERS THEN
   GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE,actual_message=MESSAGE_TEXT;
 END;
 PERFORM public.baseline_assert(actual_state=wanted_state AND strpos(actual_message,needle)>0,label);
END $fn$;
