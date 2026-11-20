\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE group_checks(name text);
GRANT SELECT,INSERT ON pg_temp.group_checks TO authenticated;
CREATE FUNCTION pg_temp.group_check(ok boolean,label text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
  INSERT INTO pg_temp.group_checks VALUES(label);RETURN 'PASS '||label;END $$;
CREATE FUNCTION pg_temp.group_fails(statement text,expected_state text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE statement;RETURN false;EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE<>expected_state THEN RAISE EXCEPTION 'Expected %, got %: %',expected_state,SQLSTATE,SQLERRM; END IF;
  RETURN true;END $$;
CREATE FUNCTION pg_temp.group_event(n integer,text_size integer DEFAULT 0,drawing text DEFAULT 'source') RETURNS jsonb LANGUAGE sql AS $$
SELECT jsonb_build_object('schema',1,'eventId','atomic-event-'||n,'projectId','66666666-1111-4111-8111-111111111111',
 'deviceId','aaaaaaaa-0000-4000-8000-000000000001','drawingId',drawing,'recordId','record-'||n,'kind','create',
 'record',jsonb_build_object('id','record-'||n,'collab',jsonb_build_object('version',1,
 'comments',jsonb_build_object('comment-'||n,jsonb_build_object('order',0,'revisions',jsonb_build_array(jsonb_build_object(
 'id','text-'||n,'parents','[]'::jsonb,'actor',jsonb_build_object('deviceId','aaaaaaaa-0000-4000-8000-000000000001','deviceName','synthetic'),
 'at',1,'text',repeat('x',text_size),'deleted',false)))),
 'fields','{}'::jsonb,'photos','{}'::jsonb,'deletion',jsonb_build_object('revisions',jsonb_build_array(jsonb_build_object(
 'id','alive-'||n,'parents','[]'::jsonb,'actor',jsonb_build_object('deviceId','aaaaaaaa-0000-4000-8000-000000000001','deviceName','synthetic'),
 'at',1,'deleted',false,'observed','[]'::jsonb))))))
$$;
CREATE FUNCTION pg_temp.group_delete(n integer) RETURNS jsonb LANGUAGE sql AS $$
SELECT jsonb_build_object('schema',1,'eventId','atomic-delete-'||n,'projectId','66666666-1111-4111-8111-111111111111',
 'deviceId','aaaaaaaa-0000-4000-8000-000000000001','drawingId','source','recordId','record-'||n,'kind','patch',
 'patch',jsonb_build_object('comments','{}'::jsonb,'fields','{}'::jsonb,'photos','{}'::jsonb,'deletion',jsonb_build_array(jsonb_build_object(
 'id','deleted-'||n,'parents',jsonb_build_array('alive-'||n),
 'actor',jsonb_build_object('deviceId','aaaaaaaa-0000-4000-8000-000000000001','deviceName','synthetic'),
 'at',2,'deleted',true,'observed',jsonb_build_array('alive-'||n,'text-'||n)))))
$$;
CREATE FUNCTION pg_temp.atomic_group(gid text,events jsonb) RETURNS jsonb LANGUAGE sql AS $$
SELECT jsonb_build_object('schema',1,'kind','atomic-group','groupId',gid,'projectId','66666666-1111-4111-8111-111111111111',
 'deviceId','aaaaaaaa-0000-4000-8000-000000000001','events',events)
$$;
INSERT INTO public.sentlog_projects(id,owner_id,status) VALUES
 ('66666666-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active'),
 ('66666666-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active');
INSERT INTO sentlog_delta_private.heads(project_id,owner_id,enabled,activated_at) VALUES
 ('66666666-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true,now()),
 ('66666666-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false,null);
CREATE TEMP TABLE group_values(name text PRIMARY KEY,value jsonb);
INSERT INTO group_values VALUES
 ('move',pg_temp.atomic_group('move-one',jsonb_build_array(pg_temp.group_delete(1),pg_temp.group_event(2,0,'destination')))),
 ('bad-move',pg_temp.atomic_group('move-fails',jsonb_build_array(pg_temp.group_delete(1),pg_temp.group_delete(999)))),
 ('big',pg_temp.atomic_group('large-move',(SELECT jsonb_agg(pg_temp.group_event(n,200000) ORDER BY n) FROM generate_series(10,15) n)));
GRANT SELECT,INSERT ON pg_temp.group_values TO authenticated;
SELECT pg_temp.group_check(NOT has_table_privilege('authenticated','sentlog_delta_private.event_groups','SELECT'),'group envelopes cannot be read directly');
SELECT pg_temp.group_check(NOT has_function_privilege('anon','public.sentlog_delta_append_group_v1(uuid,uuid,jsonb)','EXECUTE'),'anonymous group append denied');
SELECT pg_temp.group_check(NOT has_function_privilege('anon','public.sentlog_delta_list_groups_v1(uuid,uuid,bigint,integer)','EXECUTE'),'anonymous group read denied');
SELECT pg_temp.group_check(NOT has_function_privilege('anon','public.sentlog_delta_capabilities_v1(uuid,uuid)','EXECUTE'),'anonymous capability probe denied');
SELECT pg_temp.group_check(NOT (SELECT prosecdef FROM pg_proc WHERE oid='public.sentlog_delta_append_group_v1(uuid,uuid,jsonb)'::regprocedure),'public group wrapper is invoker');
SELECT pg_temp.group_check((SELECT proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE oid='sentlog_delta_private.append_group(uuid,uuid,jsonb)'::regprocedure),'group definer has empty search path');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
SELECT pg_temp.group_check(public.sentlog_delta_capabilities_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001')=
 '{"schema":2,"ownerId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","projectId":"66666666-1111-4111-8111-111111111111","deviceId":"aaaaaaaa-0000-4000-8000-000000000001","atomicGroups":true,"groupMaxEvents":500,"groupMaxBytes":4194304,"pageTargetBytes":900000}'::jsonb,'capabilities bind authorized owner project and device');
SELECT pg_temp.group_check((public.sentlog_delta_capabilities_v1('66666666-2222-4222-8222-222222222222','aaaaaaaa-0000-4000-8000-000000000001')->>'atomicGroups')::boolean,'capability check does not activate an inactive head');
SELECT public.sentlog_delta_append_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001','atomic-event-1','source','record-1',pg_temp.group_event(1));
SELECT pg_temp.group_check((public.sentlog_delta_list_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',0,1)#>>'{events,0,seq}')='1','legacy solo history remains readable before groups exist');
SELECT pg_temp.group_check(pg_temp.group_fails($q$SELECT public.sentlog_delta_append_group_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',(SELECT value FROM group_values WHERE name='bad-move'))$q$,'22023'),'second member semantic failure rejects the complete move');
RESET ROLE;
SELECT pg_temp.group_check((SELECT last_seq=1 FROM sentlog_delta_private.heads WHERE project_id='66666666-1111-4111-8111-111111111111'),'failed group rolls back the allocated sequence');
SELECT pg_temp.group_check((SELECT count(*)=1 FROM public.sentlog_delta_events WHERE project_id='66666666-1111-4111-8111-111111111111'),'failed group retains no accepted first event');
SELECT pg_temp.group_check((SELECT jsonb_array_length(collab#>'{deletion,revisions}')=1 FROM sentlog_delta_private.record_states
 WHERE project_id='66666666-1111-4111-8111-111111111111' AND record_id='record-1'),'failed move leaves the source alive');
SELECT pg_temp.group_check((SELECT count(*)=0 FROM sentlog_delta_private.event_groups WHERE project_id='66666666-1111-4111-8111-111111111111'),'failed group creates no durable group receipt');
SELECT pg_temp.group_check((SELECT count(*)=1 FROM realtime.test_messages WHERE message#>>'{payload,project_id}'='66666666-1111-4111-8111-111111111111'),'failed group creates no orphan broadcast');
SET LOCAL ROLE authenticated;
INSERT INTO group_values SELECT 'ack',public.sentlog_delta_append_group_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',value) FROM group_values WHERE name='move';
SELECT pg_temp.group_check((SELECT value->>'groupId'='move-one' AND value->>'startSeq'='2' AND value->>'endSeq'='3' AND
 value->'duplicate'='false'::jsonb AND value#>>'{events,0,eventId}'='atomic-delete-1' AND value#>>'{events,0,seq}'='2' AND
 value#>>'{events,1,eventId}'='atomic-event-2' AND value#>>'{events,1,seq}'='3' FROM group_values WHERE name='ack'),'group acknowledgement covers both ordered event identities');
SELECT pg_temp.group_check((SELECT public.sentlog_delta_append_group_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',value)=
 jsonb_set((SELECT value FROM group_values WHERE name='ack'),'{duplicate}','true'::jsonb) FROM group_values WHERE name='move'),'same group and exact content retry returns original complete acknowledgement');
SELECT pg_temp.group_check(pg_temp.group_fails($q$SELECT public.sentlog_delta_append_group_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',jsonb_set((SELECT value FROM group_values WHERE name='move'),'{events,1,record,collab,comments,comment-2,revisions,0,text}','"changed"'::jsonb))$q$,'23505'),'same group ID with changed event content is rejected');
SELECT pg_temp.group_check(pg_temp.group_fails($q$SELECT public.sentlog_delta_append_group_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',pg_temp.atomic_group('move-one',jsonb_build_array(pg_temp.group_event(2,0,'destination'),pg_temp.group_delete(1))))$q$,'23505'),'same group ID with reversed members is rejected');
SELECT pg_temp.group_check(pg_temp.group_fails($q$SELECT public.sentlog_delta_append_group_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',pg_temp.atomic_group('not-retroactive',jsonb_build_array(pg_temp.group_event(1),pg_temp.group_event(3))))$q$,'23505'),'accepted solo event cannot be adopted into a new atomic group');
SELECT pg_temp.group_check((public.sentlog_delta_list_groups_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',0,1)#>>'{events,0,seq}')='1','mixed list retains legacy solo unit');
SELECT pg_temp.group_check((SELECT x#>>'{events,0,seq}'='2' AND x#>>'{events,0,endSeq}'='3' AND jsonb_array_length(x->'events')=1 AND
 x#>'{events,0,group}'=(SELECT value FROM group_values WHERE name='move') AND x->'hasMore'='false'::jsonb FROM
 (SELECT public.sentlog_delta_list_groups_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',1,1) x) q),'one unit limit returns the entire move and its end cursor');
SELECT pg_temp.group_check(pg_temp.group_fails($q$SELECT public.sentlog_delta_list_groups_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',2,100)$q$,'22023'),'cursor inside a group cannot start from its second member');
SELECT pg_temp.group_check(pg_temp.group_fails($q$SELECT public.sentlog_delta_list_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',0,100)$q$,'55000'),'old receiver cannot obtain a flattened partial move');
SELECT public.sentlog_delta_append_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001','atomic-event-3','source','record-3',pg_temp.group_event(3));
SELECT pg_temp.group_check((public.sentlog_delta_list_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',3,100)#>>'{events,0,seq}')='4','old solo outbox remains accepted after grouped operations');
SELECT pg_temp.group_check(pg_temp.group_fails($q$SELECT public.sentlog_delta_append_group_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',pg_temp.atomic_group('duplicate-member',jsonb_build_array(pg_temp.group_event(30),pg_temp.group_event(30))))$q$,'22023'),'duplicate event ID in a group is rejected');
SELECT pg_temp.group_check(pg_temp.group_fails($q$SELECT public.sentlog_delta_append_group_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',pg_temp.atomic_group('empty','[]'::jsonb))$q$,'22023'),'empty group rejected');
SELECT pg_temp.group_check(pg_temp.group_fails($q$SELECT public.sentlog_delta_append_group_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',(SELECT value||'{"unknown":true}'::jsonb FROM group_values WHERE name='move'))$q$,'22023'),'unknown group protocol fields rejected');
SELECT pg_temp.group_check(pg_temp.group_fails($q$SELECT public.sentlog_delta_append_group_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000002',(SELECT value FROM group_values WHERE name='move'))$q$,'42501'),'stopped device cannot retry an already committed group');
SELECT pg_temp.group_check(pg_temp.group_fails($q$SELECT public.sentlog_delta_list_groups_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000002',0,100)$q$,'42501'),'stopped device cannot read groups');
SELECT pg_temp.group_check(pg_temp.group_fails($q$SELECT public.sentlog_delta_capabilities_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000002')$q$,'42501'),'stopped device cannot confirm capabilities');
SELECT pg_temp.group_check(pg_temp.group_fails($q$SELECT public.sentlog_delta_list_groups_v1('66666666-2222-4222-8222-222222222222','aaaaaaaa-0000-4000-8000-000000000001',0,100)$q$,'55000'),'group supplement does not activate other project heads');
SELECT public.sentlog_delta_append_group_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',value) FROM group_values WHERE name='big';
SELECT pg_temp.group_check((SELECT jsonb_array_length(x->'events')=1 AND x#>>'{events,0,seq}'='4' AND x->'hasMore'='true'::jsonb FROM
 (SELECT public.sentlog_delta_list_groups_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',3,100) x) q),'byte target ends before a large group without returning its first member');
SELECT pg_temp.group_check((SELECT jsonb_array_length(x->'events')=1 AND x#>>'{events,0,seq}'='5' AND x#>>'{events,0,endSeq}'='10' AND
 jsonb_array_length(x#>'{events,0,group,events}')=6 AND octet_length(x::text)>900000 AND x->'hasMore'='false'::jsonb FROM
 (SELECT public.sentlog_delta_list_groups_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',4,1) x) q),'large first group is returned intact above the usual byte target');
RESET ROLE;
SELECT pg_temp.group_check((SELECT count(*)=2 FROM sentlog_delta_private.event_groups WHERE project_id='66666666-1111-4111-8111-111111111111'),'retries and rejected operations create no extra groups');
SELECT pg_temp.group_check((SELECT jsonb_array_length(collab#>'{deletion,revisions}')=2 FROM sentlog_delta_private.record_states
 WHERE project_id='66666666-1111-4111-8111-111111111111' AND record_id='record-1'),'successful group records source deletion once');
SELECT pg_temp.group_check((SELECT count(*)=1 FROM sentlog_delta_private.record_states
 WHERE project_id='66666666-1111-4111-8111-111111111111' AND drawing_id='destination' AND record_id='record-2'),'successful group creates destination once');
UPDATE public.sentlog_projects SET status='archived' WHERE id='66666666-1111-4111-8111-111111111111';
SET LOCAL ROLE authenticated;
SELECT pg_temp.group_check(pg_temp.group_fails($q$SELECT public.sentlog_delta_append_group_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',(SELECT value FROM group_values WHERE name='move'))$q$,'42501'),'archived project rejects group retries');
SELECT pg_temp.group_check((public.sentlog_delta_list_groups_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',0,100)->>'headSeq')='10','archived project permits complete grouped reads for restoration');
RESET ROLE;
UPDATE public.sentlog_projects SET status='active' WHERE id='66666666-1111-4111-8111-111111111111';
DELETE FROM public.sentlog_delta_events WHERE project_id='66666666-1111-4111-8111-111111111111' AND seq=3;
SET LOCAL ROLE authenticated;
SELECT pg_temp.group_check(pg_temp.group_fails($q$SELECT public.sentlog_delta_list_groups_v1('66666666-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',1,1)$q$,'55000'),'corrupt group cannot be returned with a missing destination');
SELECT 'PASS atomic delta groups database: '||count(*)||' assertions; isolated data only' AS result FROM pg_temp.group_checks;
ROLLBACK;
