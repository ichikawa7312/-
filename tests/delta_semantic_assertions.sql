-- Semantic acceptance regression. All operations use an isolated test project.
-- The real service database and the normal production app remain untouched.
\set ON_ERROR_STOP on
INSERT INTO public.sentlog_projects(id,owner_id,status)
 VALUES('66666666-6666-4666-8666-666666666666','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active');
INSERT INTO sentlog_delta_private.heads(project_id,owner_id,enabled,activated_at)
 VALUES('66666666-6666-4666-8666-666666666666',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true,now());
CREATE OR REPLACE FUNCTION public.semantic_create(eid text,rid text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$
 SELECT pg_catalog.jsonb_build_object(
  'schema',1,'eventId',eid,'projectId','66666666-6666-4666-8666-666666666666',
  'drawingId','test-drawing','recordId',rid,
  'deviceId','aaaaaaaa-0000-4000-8000-000000000001','kind','create',
  'record',pg_catalog.jsonb_build_object(
   'id',rid,'memo','','photos','[]'::jsonb,
   'collab',pg_catalog.jsonb_build_object(
     'version',1,'comments','{}'::jsonb,'fields','{}'::jsonb,'photos','{}'::jsonb,
     'deletion',pg_catalog.jsonb_build_object('revisions',
       pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'id','root:'||rid,'parents','[]'::jsonb,
        'actor',pg_catalog.jsonb_build_object('deviceId',null,'deviceName','test migration'),
        'at',0,'deleted',false,'observed','[]'::jsonb))))))
$fn$;
CREATE OR REPLACE FUNCTION public.semantic_patch(eid text,rid text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$
 SELECT pg_catalog.jsonb_set(
   pg_catalog.jsonb_set(public.test_event(eid),'{projectId}',
     pg_catalog.to_jsonb('66666666-6666-4666-8666-666666666666'::text)),
   '{drawingId}',pg_catalog.to_jsonb('test-drawing'::text)
 ) || pg_catalog.jsonb_build_object('recordId',rid)
$fn$;
CREATE OR REPLACE FUNCTION public.semantic_field(eid text,rid text,rev_id text,parents jsonb,value text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $fn$
 WITH source AS (SELECT public.semantic_patch(eid,rid) AS e)
 SELECT pg_catalog.jsonb_set(e,'{patch}',
  pg_catalog.jsonb_build_object('comments','{}'::jsonb,
   'fields',pg_catalog.jsonb_build_object('member',
     pg_catalog.jsonb_build_object('revisions',
       pg_catalog.jsonb_build_array(
         pg_catalog.jsonb_build_object('id',rev_id,'parents',parents,
           'actor',pg_catalog.jsonb_build_object('deviceId','aaaaaaaa-0000-4000-8000-000000000001','deviceName','test'),
           'at',0,'value',value)))),
    'photos','{}'::jsonb,'deletion','[]'::jsonb))
 FROM source
$fn$;
CREATE OR REPLACE FUNCTION public.semantic_attempt(e jsonb,expected_code text DEFAULT '22023')
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE initial_count bigint; next_count bigint;
BEGIN
 SELECT count(*) INTO initial_count FROM public.sentlog_delta_events
  WHERE project_id='66666666-6666-4666-8666-666666666666';
 BEGIN
   PERFORM public.sentlog_delta_append_v1(
     '66666666-6666-4666-8666-666666666666',
     'aaaaaaaa-0000-4000-8000-000000000001',
     e->>'eventId',e->>'drawingId',e->>'recordId',e);
   RAISE EXCEPTION 'semantic-invalid event was ACCEPTED: %',e->>'eventId';
 EXCEPTION WHEN SQLSTATE '22023' THEN
   IF expected_code<>'22023' THEN RAISE EXCEPTION 'wrong SQLSTATE for %',e->>'eventId'; END IF;
 END;
 SELECT count(*) INTO next_count FROM public.sentlog_delta_events
  WHERE project_id='66666666-6666-4666-8666-666666666666';
 IF next_count<>initial_count THEN RAISE EXCEPTION 'invalid event was committed'; END IF;
END $fn$;
GRANT EXECUTE ON FUNCTION public.semantic_create(text,text),
  public.semantic_patch(text,text),public.semantic_field(text,text,text,jsonb,text),
  public.semantic_attempt(jsonb,text) TO authenticated;

SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
DO $test$
DECLARE
  created jsonb; parent jsonb; bad jsonb; row jsonb; first jsonb; count_before int;
BEGIN
  -- Missing record must be rejected, rather than poisoning the permanent log.
  PERFORM public.semantic_attempt(public.semantic_patch('missing-record','no-such-record'));
  SELECT count(*) INTO count_before FROM public.sentlog_delta_events
   WHERE project_id='66666666-6666-4666-8666-666666666666';
  IF count_before<>0 THEN RAISE EXCEPTION 'orphan was inserted'; END IF;

  created:=public.semantic_create('semantic-create','survey-valid');
  row:=public.sentlog_delta_append_v1('66666666-6666-4666-8666-666666666666',
   'aaaaaaaa-0000-4000-8000-000000000001',
   'semantic-create','test-drawing','survey-valid',created);
  IF row->>'seq'<>'1' THEN RAISE EXCEPTION 'new valid record could not be created'; END IF;

  PERFORM public.semantic_attempt(public.semantic_create('create-again','survey-valid'));
  PERFORM public.semantic_attempt(
    pg_catalog.jsonb_set(public.semantic_patch('missing-parent','survey-valid'),
      '{patch,comments,c,revisions,0,parents}','["unknown-parent"]'::jsonb));
  PERFORM public.semantic_attempt(
    pg_catalog.jsonb_set(public.semantic_patch('collide-with-deletion','survey-valid'),
      '{patch,comments,c,revisions,0,id}','"root:survey-valid"'::jsonb));

  -- Valid initial field + two concurrent sibling updates from the same known
  -- parent MUST both succeed; accepting only latest-wins would be data loss.
  row:=public.sentlog_delta_append_v1('66666666-6666-4666-8666-666666666666',
   'aaaaaaaa-0000-4000-8000-000000000001','field-root','test-drawing','survey-valid',
    public.semantic_field('field-root','survey-valid','root-member','[]'::jsonb,'old'));
  row:=public.sentlog_delta_append_v1('66666666-6666-4666-8666-666666666666',
   'aaaaaaaa-0000-4000-8000-000000000001','sibling-A','test-drawing','survey-valid',
    public.semantic_field('sibling-A','survey-valid','branch-A','["root-member"]'::jsonb,'A'));
  row:=public.sentlog_delta_append_v1('66666666-6666-4666-8666-666666666666',
   'aaaaaaaa-0000-4000-8000-000000000001','sibling-B','test-drawing','survey-valid',
    public.semantic_field('sibling-B','survey-valid','branch-B','["root-member"]'::jsonb,'B'));
  IF row->>'seq'<>'4' THEN RAISE EXCEPTION 'concurrent sibling lost its place'; END IF;

  PERFORM public.semantic_attempt(public.semantic_field('rewrite','survey-valid',
     'root-member','[]'::jsonb,'tampered'));
  PERFORM public.semantic_attempt(public.semantic_field('other-group-collision','survey-valid',
     'root:survey-valid','[]'::jsonb,'bad'));
  PERFORM public.semantic_attempt(public.semantic_field('unknown-field-parent','survey-valid',
     'orphan-branch','["does-not-exist"]'::jsonb,'bad'));
  -- A comment's order cannot change after its first successful revision.
  row:=public.sentlog_delta_append_v1('66666666-6666-4666-8666-666666666666',
   'aaaaaaaa-0000-4000-8000-000000000001','first-comment','test-drawing','survey-valid',
    public.semantic_patch('first-comment','survey-valid'));
  bad:=public.semantic_patch('wrong-comment-order','survey-valid');
  bad:=pg_catalog.jsonb_set(bad,'{patch,comments,c,order}','1'::jsonb);
  PERFORM public.semantic_attempt(bad);
  -- A deletion cannot claim to have observed revisions never accepted.
  bad:=public.semantic_patch('unknown-observed','survey-valid');
  bad:=pg_catalog.jsonb_set(bad,'{patch,comments}','{}'::jsonb);
  bad:=pg_catalog.jsonb_set(bad,'{patch,deletion}',
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('id','bad-deletion','parents','["root:survey-valid"]'::jsonb,
        'actor',pg_catalog.jsonb_build_object('deviceId',null,'deviceName','test'),
        'at',0,'deleted',true,'observed','["not-present"]'::jsonb)));
  PERFORM public.semantic_attempt(bad);

  -- A cycle with two valid-looking revisions is not a valid initial record.
  bad:=public.semantic_create('cycle-create','survey-cycle');
  parent:=pg_catalog.jsonb_build_object('actor',
      pg_catalog.jsonb_build_object('deviceId',null,'deviceName','test'),'at',0,'text','x','deleted',false);
  bad:=pg_catalog.jsonb_set(bad,'{record,collab,comments}',
    pg_catalog.jsonb_build_object('c',pg_catalog.jsonb_build_object('order',0,'revisions',
      pg_catalog.jsonb_build_array(
        parent||'{"id":"cycle-a","parents":["cycle-b"]}'::jsonb,
        parent||'{"id":"cycle-b","parents":["cycle-a"]}'::jsonb))));
  PERFORM public.semantic_attempt(bad);

  -- Exact retry returns the same number without changing accepted history.
  row:=public.sentlog_delta_append_v1('66666666-6666-4666-8666-666666666666',
   'aaaaaaaa-0000-4000-8000-000000000001',
    'sibling-B','test-drawing','survey-valid',
    public.semantic_field('sibling-B','survey-valid','branch-B','["root-member"]'::jsonb,'B'));
  IF row->>'seq'<>'4' OR row->>'duplicate'<>'true' THEN
    RAISE EXCEPTION 'duplicate acknowledgement changed the history'; END IF;
END $test$;
RESET ROLE;
DO $test$
DECLARE c jsonb; n bigint; seq bigint;
BEGIN
 SELECT collab,last_seq INTO c,seq FROM sentlog_delta_private.record_states
 WHERE project_id='66666666-6666-4666-8666-666666666666'
   AND drawing_id='test-drawing' AND record_id='survey-valid';
 n:=(SELECT count(*) FROM pg_catalog.jsonb_array_elements(c#>'{fields,member,revisions}'));
 IF n<>3 OR seq<>5 OR (SELECT count(*) FROM public.sentlog_delta_events
    WHERE project_id='66666666-6666-4666-8666-666666666666')<>5 THEN
    RAISE EXCEPTION 'accepted history corrupted: member revisions %, seq %',n,seq;
 END IF;
 IF (SELECT count(*) FROM realtime.test_messages
  WHERE message#>>'{payload,project_id}'='66666666-6666-4666-8666-666666666666')<>5 THEN
    RAISE EXCEPTION 'rejected events emitted broadcasts'; END IF;
 IF pg_catalog.has_table_privilege('authenticated','sentlog_delta_private.record_states',
    'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'record state ledger must be private'; END IF;
END $test$;
SELECT 'PASS semantic server: valid concurrent forks retained; unknown parent/record, cycles and rewrites rejected atomically' AS result;
