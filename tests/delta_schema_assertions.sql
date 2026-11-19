-- Executed only against disposable PostgreSQL CI service.
\set ON_ERROR_STOP on
INSERT INTO sentlog_delta_private.heads(project_id,owner_id,last_seq,enabled,activated_at)
VALUES
 ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',0,true,now()),
 ('22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',0,true,now()),
 ('33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',0,true,now());
CREATE OR REPLACE FUNCTION public.test_event(eid text,body text DEFAULT 'A',project text DEFAULT '11111111-1111-4111-8111-111111111111',
  dev text DEFAULT 'aaaaaaaa-0000-4000-8000-000000000001') RETURNS jsonb
LANGUAGE sql SECURITY INVOKER AS $$
 SELECT pg_catalog.jsonb_build_object(
  'schema',1,'eventId',eid,'projectId',project,'deviceId',dev,
  'drawingId','drawing-1','recordId','survey-1','kind','patch',
  'patch',pg_catalog.jsonb_build_object('comments',pg_catalog.jsonb_build_object('c',body))
 )
$$;
GRANT EXECUTE ON FUNCTION public.test_event(text,text,text,text) TO authenticated;
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
DO $$
DECLARE a jsonb; b jsonb;
BEGIN
 a:=public.sentlog_delta_append_v1(
  '11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',
  'event-1','drawing-1','survey-1',public.test_event('event-1','value'));
 IF (a->>'seq')::bigint <> 1 OR (a->>'duplicate')::boolean THEN
  RAISE EXCEPTION 'first commit sequence or duplicate result wrong: %',a;
 END IF;
 b:=public.sentlog_delta_append_v1(
  '11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',
  'event-1','drawing-1','survey-1',public.test_event('event-1','value'));
 IF (b->>'seq')::bigint <> 1 OR NOT (b->>'duplicate')::boolean THEN
  RAISE EXCEPTION 'identical event replay was not idempotent: %',b;
 END IF;
 IF (SELECT count(*) FROM public.sentlog_delta_events WHERE owner_id=auth.uid()) <> 1 THEN
  RAISE EXCEPTION 'unexpected event count after duplicate';
 END IF;
END $$;
DO $$
BEGIN
 BEGIN
  PERFORM public.sentlog_delta_append_v1(
   '11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',
   'event-1','drawing-1','survey-1',public.test_event('event-1','tampered'));
  RAISE EXCEPTION 'conflicting replay should be refused';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
END $$;
DO $$
BEGIN
 BEGIN
  PERFORM public.sentlog_delta_append_v1(
   '11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000002',
   'inactive','drawing-1','survey-1',
   public.test_event('inactive','value','11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-0000-4000-8000-000000000002'));
  RAISE EXCEPTION 'inactive device should be refused';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM public.sentlog_delta_append_v1(
   '33333333-3333-4333-8333-333333333333','aaaaaaaa-0000-4000-8000-000000000001',
   'archived','drawing-1','survey-1',
   public.test_event('archived','value','33333333-3333-4333-8333-333333333333'));
  RAISE EXCEPTION 'archived projects should be refused';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM public.sentlog_delta_append_v1(
   '11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',
   'bad-envelope','drawing-1','survey-1',public.test_event('wrong-id'));
  RAISE EXCEPTION 'wrong event identity should be refused';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
END $$;
-- Transactional event sequence test: rollback must not leave a hole.
BEGIN;
SELECT public.sentlog_delta_append_v1(
 '11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',
 'will-roll-back','drawing-1','survey-1',public.test_event('will-roll-back')) AS simulated;
ROLLBACK;
DO $$
DECLARE r jsonb;
BEGIN
 r:=public.sentlog_delta_append_v1(
 '11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',
 'real-second','drawing-1','survey-1',public.test_event('real-second'));
 IF (r->>'seq')::bigint <> 2 THEN
  RAISE EXCEPTION 'rollback must not leave a sequence gap: %',r;
 END IF;
END $$;
-- Confirm a different user cannot see or post the first user's events.
SELECT pg_catalog.set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',false);
DO $$
BEGIN
 IF (SELECT count(*) FROM public.sentlog_delta_events) <> 0 THEN
  RAISE EXCEPTION 'row-level security leaked a project to the other account';
 END IF;
 BEGIN
  PERFORM public.sentlog_delta_append_v1(
   '11111111-1111-4111-8111-111111111111','bbbbbbbb-0000-4000-8000-000000000003',
   'cross-user','drawing-1','survey-1',
   public.test_event('cross-user','value','11111111-1111-4111-8111-111111111111',
     'bbbbbbbb-0000-4000-8000-000000000003'));
  RAISE EXCEPTION 'cross-user append succeeded';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 IF pg_catalog.has_table_privilege('authenticated','public.sentlog_delta_events','INSERT') THEN
  RAISE EXCEPTION 'clients must not have permission to insert events directly';
 END IF;
END $$;
RESET ROLE;
DO $$
BEGIN
 IF (SELECT count(*) FROM public.sentlog_delta_events) <> 2 THEN
  RAISE EXCEPTION 'events were lost or duplicated';
 END IF;
 IF (SELECT last_seq FROM sentlog_delta_private.heads WHERE project_id='11111111-1111-4111-8111-111111111111') <> 2 THEN
  RAISE EXCEPTION 'head sequence mismatches committed rows';
 END IF;
 IF (SELECT count(*) FROM realtime.test_messages) <> 2 THEN
  RAISE EXCEPTION 'broadcast must occur once per committed event only';
 END IF;
END $$;
SELECT 'PASS SQL server: RLS, active devices, idempotency, rejected collisions, no sequence gaps, broadcast' AS result;
-- Verify dormant mode and that legacy snapshot writes are explicitly refused
-- after test activation. Production activation is NOT performed here.
INSERT INTO public.sentlog_projects(id,owner_id,status)
VALUES('44444444-4444-4444-8444-444444444444','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active');
INSERT INTO public.sentlog_project_snapshots(project_id,revision)
VALUES('44444444-4444-4444-8444-444444444444',1);
INSERT INTO sentlog_delta_private.heads(project_id,owner_id,last_seq,enabled)
VALUES('44444444-4444-4444-8444-444444444444','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',0,false);
CREATE TRIGGER delta_guard_test BEFORE UPDATE ON public.sentlog_project_snapshots
  FOR EACH ROW EXECUTE FUNCTION sentlog_delta_private.reject_legacy_snapshot();
GRANT UPDATE ON public.sentlog_project_snapshots TO authenticated;
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
DO $
BEGIN
 BEGIN
   UPDATE public.sentlog_project_snapshots SET revision=10
     WHERE project_id='11111111-1111-4111-8111-111111111111';
   RAISE EXCEPTION 'an older client overwrote a delta-enabled snapshot';
 EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
 END;
 UPDATE public.sentlog_project_snapshots SET revision=2
   WHERE project_id='44444444-4444-4444-8444-444444444444';
 IF (SELECT revision FROM public.sentlog_project_snapshots
     WHERE project_id='44444444-4444-4444-8444-444444444444')<>2 THEN
   RAISE EXCEPTION 'inactive delta mode must preserve old snapshot updates';
 END IF;
END $;
RESET ROLE;
SELECT 'PASS SQL server: legacy-client writes blocked after activation; inactive projects stay writable' AS result;

