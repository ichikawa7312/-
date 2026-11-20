\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE transport_checks(name text);
GRANT SELECT,INSERT ON pg_temp.transport_checks TO authenticated,anon;
CREATE FUNCTION pg_temp.check(ok boolean,label text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
  INSERT INTO pg_temp.transport_checks VALUES(label);RETURN 'PASS '||label;END $$;
CREATE FUNCTION pg_temp.fails(statement text,expected_state text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE statement;RETURN false;EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE<>expected_state THEN RAISE EXCEPTION 'Expected %, got %: %',expected_state,SQLSTATE,SQLERRM; END IF;
  RETURN true;END $$;
CREATE FUNCTION pg_temp.event(n integer,pid uuid,did uuid) RETURNS jsonb LANGUAGE sql AS $$
SELECT jsonb_build_object('schema',1,'eventId','transport-'||n,'projectId',pid,'deviceId',did,
 'drawingId','drawing','recordId','record-'||n,'kind','create','record',jsonb_build_object(
 'id','record-'||n,'collab',jsonb_build_object('version',1,'comments',jsonb_build_object('comment-'||n,
 jsonb_build_object('order',0,'revisions',jsonb_build_array(jsonb_build_object('id','text-'||n,'parents','[]'::jsonb,
 'actor',jsonb_build_object('deviceId',did,'deviceName','synthetic'),'at',1,'text',repeat('x',200000),'deleted',false)))),
 'fields','{}'::jsonb,'photos','{}'::jsonb,'deletion',jsonb_build_object('revisions',jsonb_build_array(jsonb_build_object(
 'id','alive-'||n,'parents','[]'::jsonb,'actor',jsonb_build_object('deviceId',did,'deviceName','synthetic'),
 'at',1,'deleted',false,'observed','[]'::jsonb))))))
$$;

INSERT INTO public.sentlog_projects(id,owner_id,status) VALUES
 ('88888888-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active'),
 ('88888888-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active'),
 ('88888888-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active'),
 -- The schema suite's global archived project already has an enabled head.
 -- Own this negative fixture so prior suites cannot change its meaning.
 ('88888888-4444-4444-8444-444444444444','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','archived');
INSERT INTO sentlog_delta_private.heads(project_id,owner_id,enabled,activated_at) VALUES
 ('88888888-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true,now()),
 ('88888888-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false,null);
SELECT pg_temp.check(NOT has_table_privilege('authenticated','public.sentlog_delta_events','SELECT'),'event table has no authenticated direct read');
SELECT pg_temp.check(NOT has_table_privilege('anon','public.sentlog_delta_events','SELECT'),'anonymous event read is denied');
SELECT pg_temp.check(NOT has_function_privilege('anon','public.sentlog_delta_list_v1(uuid,uuid,bigint,integer)','EXECUTE'),'anonymous list RPC is denied');
SELECT pg_temp.check(NOT has_function_privilege('anon','sentlog_delta_private.list_events(uuid,uuid,bigint,integer)','EXECUTE'),'anonymous private helper is denied');
SELECT pg_temp.check(NOT (SELECT prosecdef FROM pg_proc WHERE oid='public.sentlog_delta_list_v1(uuid,uuid,bigint,integer)'::regprocedure),'public wrapper is invoker');
SELECT pg_temp.check((SELECT proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE oid='sentlog_delta_private.list_events(uuid,uuid,bigint,integer)'::regprocedure),'definer has empty search path');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','',true);
SELECT pg_temp.check(pg_temp.fails($q$SELECT public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',0,100)$q$,'28000'),'list requires authenticated user');
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
SELECT pg_temp.check(pg_temp.fails('SELECT * FROM public.sentlog_delta_events','42501'),'table read cannot bypass device checks');
SELECT pg_temp.check(pg_temp.fails($q$SELECT public.sentlog_delta_list_v1('22222222-2222-4222-8222-222222222222','aaaaaaaa-0000-4000-8000-000000000001',0,100)$q$,'42501'),'foreign project denied');
SELECT pg_temp.check(pg_temp.fails($q$SELECT public.sentlog_delta_list_v1('88888888-4444-4444-8444-444444444444','aaaaaaaa-0000-4000-8000-000000000001',0,100)$q$,'55000'),'archived legacy project still requires an activated delta head');
SELECT pg_temp.check(pg_temp.fails($q$SELECT public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000002',0,100)$q$,'42501'),'inactive device denied');
SELECT pg_temp.check(pg_temp.fails($q$SELECT public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','bbbbbbbb-0000-4000-8000-000000000003',0,100)$q$,'42501'),'foreign device denied');
SELECT pg_temp.check(pg_temp.fails($q$SELECT public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000099',0,100)$q$,'42501'),'unknown device denied');
SELECT pg_temp.check(pg_temp.fails($q$SELECT public.sentlog_delta_list_v1('88888888-2222-4222-8222-222222222222','aaaaaaaa-0000-4000-8000-000000000001',0,100)$q$,'55000'),'unactivated project denied');
SELECT pg_temp.check(pg_temp.fails($q$SELECT public.sentlog_delta_list_v1('88888888-3333-4333-8333-333333333333','aaaaaaaa-0000-4000-8000-000000000001',0,100)$q$,'55000'),'missing head denied');
SELECT pg_temp.check(pg_temp.fails($q$SELECT public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',-1,100)$q$,'22023'),'negative cursor denied');
SELECT pg_temp.check(pg_temp.fails($q$SELECT public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',9007199254740992,100)$q$,'22023'),'unsafe integer cursor denied');
SELECT pg_temp.check(pg_temp.fails($q$SELECT public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',0,0)$q$,'22023'),'zero page denied');
SELECT pg_temp.check(pg_temp.fails($q$SELECT public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',0,501)$q$,'22023'),'oversized page denied');
SELECT pg_temp.check(pg_temp.fails($q$SELECT public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',null,100)$q$,'22023'),'null cursor denied');
SELECT pg_temp.check(public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',0,100)->'events'='[]'::jsonb,'activated empty project returns an empty page');
DO $$ DECLARE i integer; e jsonb; BEGIN FOR i IN 1..6 LOOP
 e:=pg_temp.event(i,'88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001');
 PERFORM public.sentlog_delta_append_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',
 e->>'eventId','drawing',e->>'recordId',e);END LOOP;END $$;
CREATE TEMP TABLE transport_page AS SELECT public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',0,100) AS value;
SELECT pg_temp.check((SELECT value->>'ownerId'='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND value->>'projectId'='88888888-1111-4111-8111-111111111111'
 AND value->>'deviceId'='aaaaaaaa-0000-4000-8000-000000000001' AND (value->>'headSeq')::bigint=6 AND (value->>'after')::bigint=0 FROM transport_page),'page receipt binds owner project device and cursor');
SELECT pg_temp.check((SELECT jsonb_array_length(value->'events')=4 AND (value->>'hasMore')::boolean AND octet_length(value::text)<910000 FROM transport_page),'large histories use byte-bounded partial pages');
SELECT pg_temp.check((SELECT value#>>'{events,0,seq}'='1' AND value#>>'{events,3,seq}'='4' FROM transport_page),'partial page remains contiguous');
SELECT pg_temp.check((SELECT value#>'{events,2,event}'=pg_temp.event(3,'88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001') FROM transport_page),'event payload is preserved exactly');
SELECT pg_temp.check((SELECT jsonb_array_length(x->'events')=2 AND x#>>'{events,0,seq}'='5' AND NOT (x->>'hasMore')::boolean FROM
 (SELECT public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',4,100) x) q),'next page resumes after the durable cursor');
SELECT pg_temp.check((SELECT jsonb_array_length(x->'events')=1 AND (x->>'hasMore')::boolean FROM
 (SELECT public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',0,1) x) q),'count limit is also enforced');
SELECT pg_temp.check((SELECT x->'events'='[]'::jsonb AND NOT (x->>'hasMore')::boolean FROM
 (SELECT public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',6,100) x) q),'caught-up cursor has an explicit final empty page');
SELECT pg_temp.check(pg_temp.fails($q$SELECT public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',7,100)$q$,'22023'),'cursor ahead of head cannot claim completion');

SELECT set_config('test.realtime.topic','sentlog-delta:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
SELECT pg_temp.check((SELECT count(*)=1 FROM realtime.messages),'own private delta topic admits broadcast only');
SELECT pg_temp.check(pg_temp.fails($q$INSERT INTO realtime.messages(extension,topic) VALUES('broadcast','spoofed')$q$,'42501'),'client cannot publish a delta hint despite broad old send policy');
SELECT set_config('test.realtime.topic','sentlog-delta:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
SELECT pg_temp.check((SELECT count(*)=0 FROM realtime.messages),'foreign delta topic denied despite broad old read policy');
SELECT set_config('test.realtime.topic','sentlog-records:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
SELECT pg_temp.check((SELECT count(*)=2 FROM realtime.messages),'old notification namespaces retain their policy behavior');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('test.realtime.topic','sentlog-delta:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
SELECT pg_temp.check((SELECT count(*)=0 FROM realtime.messages),'anonymous delta subscribe is denied despite a broad public policy');
SELECT pg_temp.check(pg_temp.fails($q$INSERT INTO realtime.messages(extension,topic) VALUES('broadcast','spoofed')$q$,'42501'),'anonymous delta publish is denied despite a broad public policy');
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);

RESET ROLE;
SELECT pg_temp.check((SELECT count(*)=6 FROM public.sentlog_delta_events WHERE project_id='88888888-1111-4111-8111-111111111111'),'reads do not append or delete events');
UPDATE public.sentlog_projects SET status='archived' WHERE id='88888888-1111-4111-8111-111111111111';
SET LOCAL ROLE authenticated;
SELECT pg_temp.check((public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',0,100)->>'headSeq')='6','archived project retains owned registered-device read access for restoration');
RESET ROLE;
UPDATE public.sentlog_projects SET status='active' WHERE id='88888888-1111-4111-8111-111111111111';
UPDATE public.sentlog_devices SET active=false WHERE id='aaaaaaaa-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT pg_temp.check(pg_temp.fails($q$SELECT public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',0,100)$q$,'42501'),'device stop after a prior read prevents the next read');
RESET ROLE;
UPDATE public.sentlog_devices SET active=true WHERE id='aaaaaaaa-0000-4000-8000-000000000001';
DELETE FROM public.sentlog_delta_events WHERE project_id='88888888-1111-4111-8111-111111111111' AND seq=6;
SET LOCAL ROLE authenticated;
SELECT pg_temp.check(pg_temp.fails($q$SELECT public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',5,100)$q$,'55000'),'missing last event cannot look like an empty caught-up page');
RESET ROLE;
DELETE FROM public.sentlog_delta_events WHERE project_id='88888888-1111-4111-8111-111111111111' AND seq=2;
SET LOCAL ROLE authenticated;
SELECT pg_temp.check(pg_temp.fails($q$SELECT public.sentlog_delta_list_v1('88888888-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',0,100)$q$,'55000'),'sequence gap rejects the whole response');
SELECT 'PASS delta transport database: '||count(*)||' assertions; isolated data only' AS result FROM pg_temp.transport_checks;
ROLLBACK;
