\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE archive_checks(name text);
GRANT SELECT,INSERT ON pg_temp.archive_checks TO authenticated;
CREATE FUNCTION pg_temp.archive_check(ok boolean,label text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
 INSERT INTO pg_temp.archive_checks VALUES(label);RETURN 'PASS '||label;END $$;
CREATE FUNCTION pg_temp.archive_fails(statement text,state text,marker text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE statement;RETURN false;EXCEPTION WHEN OTHERS THEN
 IF SQLSTATE<>state OR position(marker IN SQLERRM)=0 THEN RAISE EXCEPTION 'Expected % %, got %: %',state,marker,SQLSTATE,SQLERRM; END IF;
 RETURN true;END $$;
CREATE FUNCTION pg_temp.archive_event(label text,pid uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('schema',1,'eventId',label,'projectId',pid,'deviceId','aaaaaaaa-0000-4000-8000-000000000001',
 'drawingId','drawing','recordId',label,'kind','create','record',jsonb_build_object('id',label,'collab',
 jsonb_build_object('version',1,'comments','{}'::jsonb,'fields','{}'::jsonb,'photos','{}'::jsonb,'deletion',jsonb_build_object(
 'revisions',jsonb_build_array(jsonb_build_object('id','alive-'||label,'parents','[]'::jsonb,
 'actor',jsonb_build_object('deviceId','aaaaaaaa-0000-4000-8000-000000000001','deviceName','synthetic'),
 'at',1,'deleted',false,'observed','[]'::jsonb))))))
$$;
CREATE FUNCTION pg_temp.archive_group(label text,pid uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('schema',1,'kind','atomic-group','groupId',label,'projectId',pid,'deviceId','aaaaaaaa-0000-4000-8000-000000000001',
 'events',jsonb_build_array(pg_temp.archive_event(label||'-source',pid),pg_temp.archive_event(label||'-destination',pid)))
$$;
CREATE TEMP TABLE archive_values(name text PRIMARY KEY,value jsonb);
INSERT INTO archive_values SELECT 'frozen',to_jsonb(j) FROM sentlog_archive_private.jobs j
 WHERE project_id='44444444-1111-4111-8111-111111111111' AND state='checking';
GRANT SELECT,INSERT ON pg_temp.archive_values TO authenticated;
SELECT pg_temp.archive_check((SELECT value->'pc_receipt' IS NOT NULL FROM archive_values WHERE name='frozen'),'pre-fix fixture has a real legacy PC completion receipt');
SELECT pg_temp.archive_check(NOT has_function_privilege('authenticated','sentlog_delta_private.assert_archive_writable(uuid)','EXECUTE'),'archive authorization helper is not a client API');
SELECT pg_temp.archive_check((SELECT proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE oid='sentlog_delta_private.guard_archive_write()'::regprocedure),'archive write guard has empty search path');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
SELECT pg_temp.archive_check(pg_temp.archive_fails($q$SELECT public.sentlog_delta_append_v1('44444444-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',
 'freeze-solo','drawing','freeze-solo',pg_temp.archive_event('freeze-solo','44444444-1111-4111-8111-111111111111'))$q$,'55000','DELTA_ARCHIVE_FROZEN'),'checking archive rejects a new solo append');
SELECT pg_temp.archive_check(pg_temp.archive_fails($q$SELECT public.sentlog_delta_append_group_v1('44444444-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',
 pg_temp.archive_group('freeze-move','44444444-1111-4111-8111-111111111111'))$q$,'55000','DELTA_ARCHIVE_FROZEN'),'checking archive rejects the complete atomic group');
SELECT pg_temp.archive_check(pg_temp.archive_fails($q$SELECT public.sentlog_archive_v1('finalize','44444444-1111-4111-8111-111111111111',
 'aaaaaaaa-0000-4000-8000-000000000001',jsonb_build_object('job_id',(SELECT value->>'id' FROM archive_values WHERE name='frozen')))$q$,
 '55000','DELTA_ARCHIVE_PROJECTION_REQUIRED'),'pre-fix PC receipt cannot falsely finalize a delta archive');
SELECT pg_temp.archive_check(pg_temp.archive_fails($q$SELECT public.sentlog_archive_v1('begin','44444444-3333-4333-8333-333333333333',
 'aaaaaaaa-0000-4000-8000-000000000001','{"revision":1}'::jsonb)$q$,'55000','DELTA_ARCHIVE_PROJECTION_REQUIRED'),'enabled delta project cannot begin a snapshot-only archive');
RESET ROLE;
SELECT pg_temp.archive_check((SELECT last_seq=0 FROM sentlog_delta_private.heads WHERE project_id='44444444-1111-4111-8111-111111111111'),'frozen appends leave head unchanged');
SELECT pg_temp.archive_check(NOT EXISTS(SELECT 1 FROM public.sentlog_delta_events WHERE project_id='44444444-1111-4111-8111-111111111111'),'frozen appends leave no accepted event');
SELECT pg_temp.archive_check(NOT EXISTS(SELECT 1 FROM sentlog_delta_private.record_states WHERE project_id='44444444-1111-4111-8111-111111111111'),'frozen appends roll back semantic record state');
SELECT pg_temp.archive_check(NOT EXISTS(SELECT 1 FROM sentlog_delta_private.event_groups WHERE project_id='44444444-1111-4111-8111-111111111111'),'frozen append leaves no group receipt');
SELECT pg_temp.archive_check(NOT EXISTS(SELECT 1 FROM realtime.test_messages WHERE message#>>'{payload,project_id}'='44444444-1111-4111-8111-111111111111'),'frozen append leaves no broadcast');
SELECT pg_temp.archive_check((SELECT status='active' FROM public.sentlog_projects WHERE id='44444444-1111-4111-8111-111111111111'),'refused finalize leaves the delta project active');
SELECT pg_temp.archive_check(NOT EXISTS(SELECT 1 FROM sentlog_archive_private.jobs WHERE project_id='44444444-3333-4333-8333-333333333333'),'refused delta begin leaves no stale archive job');
-- A missing dependency must not be interpreted as "there is no archive freeze".
ALTER TABLE sentlog_archive_private.jobs RENAME TO temporarily_missing_jobs;
SET LOCAL ROLE authenticated;
SELECT pg_temp.archive_check(pg_temp.archive_fails($q$SELECT public.sentlog_delta_append_v1('44444444-3333-4333-8333-333333333333','aaaaaaaa-0000-4000-8000-000000000001',
 'missing-archive','drawing','missing-archive',pg_temp.archive_event('missing-archive','44444444-3333-4333-8333-333333333333'))$q$,'55000','DELTA_ARCHIVE_PROTOCOL_REQUIRED'),'missing archive table fails closed');
RESET ROLE;
ALTER TABLE sentlog_archive_private.temporarily_missing_jobs RENAME TO jobs;
SET LOCAL ROLE authenticated;
SELECT public.sentlog_archive_v1('cancel','44444444-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',
 jsonb_build_object('job_id',(SELECT value->>'id' FROM archive_values WHERE name='frozen')));
SELECT pg_temp.archive_check((public.sentlog_delta_append_group_v1('44444444-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',
 pg_temp.archive_group('after-cancel','44444444-1111-4111-8111-111111111111'))->>'endSeq')='2','cancelled check allows the complete delta write to resume');
-- Run the real legacy metadata + phone report + PC receipt + archive flow.
RESET ROLE;
UPDATE public.sentlog_project_snapshots SET revision=2,payload=jsonb_set(payload,'{project,custom,scale}','200'::jsonb)
 WHERE project_id='44444444-2222-4222-8222-222222222222';
SET LOCAL ROLE authenticated;
INSERT INTO archive_values SELECT 'legacy',public.sentlog_archive_v1('begin','44444444-2222-4222-8222-222222222222',
 'aaaaaaaa-0000-4000-8000-000000000001','{"revision":2}'::jsonb);
RESET ROLE;
SELECT pg_temp.archive_check(pg_temp.archive_fails($q$UPDATE sentlog_delta_private.heads SET enabled=true,activated_at=now()
 WHERE project_id='44444444-2222-4222-8222-222222222222'$q$,'55000','DELTA_ARCHIVE_FROZEN'),'activation cannot cross an existing legacy archive check');
SET LOCAL ROLE authenticated;
SELECT public.sentlog_archive_v1('report','44444444-2222-4222-8222-222222222222','aaaaaaaa-0000-4000-8000-000000000001',
 jsonb_build_object('job_id',value->>'id','catalog_hash',value->>'catalog_hash','clean',true)) FROM archive_values WHERE name='legacy';
SELECT public.sentlog_archive_v1('pc_complete','44444444-2222-4222-8222-222222222222','aaaaaaaa-0000-4000-8000-000000000099',
 jsonb_build_object('job_id',value->>'id','catalog_hash',value->>'catalog_hash','file_count',0,'package_sha256',repeat('a',64),'path','synthetic-legacy-backup'))
 FROM archive_values WHERE name='legacy';
SELECT pg_temp.archive_check((SELECT public.sentlog_archive_v1('finalize','44444444-2222-4222-8222-222222222222',
 'aaaaaaaa-0000-4000-8000-000000000001',jsonb_build_object('job_id',value->>'id'))->>'status'='archived' FROM archive_values WHERE name='legacy'),
 'legacy phone and PC archive finalize remains supported');
RESET ROLE;
SELECT pg_temp.archive_check((SELECT payload#>>'{project,custom,scale}'='200' AND payload#>>'{project,custom,note}'='unknown metadata survives'
 FROM public.sentlog_project_snapshots WHERE project_id='44444444-2222-4222-8222-222222222222'),'legacy metadata and unknown fields survive archive unchanged');
SELECT pg_temp.archive_check((SELECT state='archived' AND pc_receipt->>'path'='synthetic-legacy-backup' FROM sentlog_archive_private.jobs
 WHERE project_id='44444444-2222-4222-8222-222222222222'),'legacy PC receipt and archive state remain durable');
SET LOCAL ROLE authenticated;
SELECT pg_temp.archive_check(public.sentlog_archive_v1('reopen','44444444-2222-4222-8222-222222222222',
 'aaaaaaaa-0000-4000-8000-000000000001')->>'status'='active','legacy reopen remains supported');
SELECT 'PASS delta/archive compatibility: '||count(*)||' assertions with the actual legacy archive gateway' AS result FROM pg_temp.archive_checks;
ROLLBACK;
