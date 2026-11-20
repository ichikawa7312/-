-- Disposable loopback PostgreSQL fixture, used only by checkpoint_races.sh.
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
SELECT set_config('request.headers','{"x-client-info":"sentlog-collaboration/1"}',false);
INSERT INTO public.sentlog_projects(id,owner_id,status,client_key,name)
 SELECT ('66000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active','checkpoint-race-'||n,'Checkpoint race'
 FROM generate_series(1,5) n;
INSERT INTO public.sentlog_project_snapshots(project_id,owner_id,revision,payload,updated_by_device)
 SELECT id,owner_id,1,jsonb_build_object('project',jsonb_build_object('id',client_key,'name','Race',
 'collaborationVersion',1,'drawings','[{"id":"drawing"}]'::jsonb),
 'drawings','[{"meta":{"id":"drawing"},"state":{"shapes":[],"scale":100}}]'::jsonb),
 'aaaaaaaa-0000-4000-8000-000000000001'
 FROM public.sentlog_projects WHERE client_key LIKE 'checkpoint-race-%';
INSERT INTO public.sentlog_assets(project_id,owner_id,client_key,kind,file_name,mime_type,byte_size,sha256,storage_path,status)
 SELECT id,owner_id,'drawing:drawing','drawing','race.pdf','application/pdf',3,repeat('1',64),'synthetic/race.pdf','uploaded'
 FROM public.sentlog_projects WHERE client_key LIKE 'checkpoint-race-%';
DO $prepare$
DECLARE project record;receipt jsonb;
BEGIN
 FOR project IN SELECT id,client_key FROM public.sentlog_projects WHERE client_key LIKE 'checkpoint-race-%' ORDER BY id LOOP
  receipt:=public.sentlog_delta_prepare_baseline_v1(project.id,'aaaaaaaa-0000-4000-8000-000000000001',1);
  PERFORM sentlog_delta_private.activate_prepared_baseline(project.id,'aaaaaaaa-0000-4000-8000-000000000001',(receipt->>'baselineId')::uuid);
  PERFORM sentlog_delta_private.seed_metadata_baseline(project.id,'aaaaaaaa-0000-4000-8000-000000000001',(receipt->>'baselineId')::uuid);
  IF project.client_key NOT IN ('checkpoint-race-2','checkpoint-race-5') THEN
   PERFORM public.sentlog_delta_publish_checkpoint_v1(project.id,'aaaaaaaa-0000-4000-8000-000000000001',0,'initial'); END IF;
 END LOOP;
END $prepare$;
CREATE FUNCTION public.delta_checkpoint_test_event(label text,pid uuid) RETURNS jsonb LANGUAGE sql AS $fn$
 SELECT jsonb_build_object('schema',1,'eventId',label,'projectId',pid,'deviceId','aaaaaaaa-0000-4000-8000-000000000001',
 'drawingId','drawing','recordId',label,'kind','create','record',jsonb_build_object('id',label,'collab',
 jsonb_build_object('version',1,'comments','{}'::jsonb,'fields','{}'::jsonb,'photos','{}'::jsonb,'deletion',jsonb_build_object(
 'revisions',jsonb_build_array(jsonb_build_object('id','alive-'||label,'parents','[]'::jsonb,
 'actor',jsonb_build_object('deviceId','aaaaaaaa-0000-4000-8000-000000000001','deviceName','synthetic'),
 'at',1,'deleted',false,'observed','[]'::jsonb))))))
$fn$;
