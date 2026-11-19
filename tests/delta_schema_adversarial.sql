-- Disposable database only. Roll back every adversarial write so the existing
-- parallel fixture remains at its original two committed events.
\set ON_ERROR_STOP on
BEGIN;
CREATE OR REPLACE FUNCTION public.test_delta_reject(e jsonb, expected_code text DEFAULT '22023')
RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $test$
DECLARE actual_code text;
BEGIN
  BEGIN
    PERFORM public.sentlog_delta_append_v1(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-0000-4000-8000-000000000001',
      'adversarial','drawing-1','survey-1',e);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_code = RETURNED_SQLSTATE;
    IF actual_code = expected_code THEN RETURN; END IF;
    RAISE EXCEPTION 'wrong rejection: expected %, got % for %',expected_code,actual_code,e;
  END;
  RAISE EXCEPTION 'unsafe envelope accepted: %',e;
END $test$;
GRANT EXECUTE ON FUNCTION public.test_delta_reject(jsonb,text) TO authenticated;
CREATE TEMP TABLE delta_rejected_cases(label text PRIMARY KEY,envelope jsonb);
WITH base AS (SELECT public.test_event('adversarial') AS e)
INSERT INTO delta_rejected_cases
SELECT label,envelope FROM base CROSS JOIN LATERAL (VALUES
 ('envelope SQL null',NULL::jsonb),('envelope JSON null','null'::jsonb),
 ('envelope array','[]'::jsonb),('envelope boolean','true'::jsonb),
 ('schema missing',e-'schema'),('schema null',e||'{"schema":null}'),
 ('schema string',e||'{"schema":"1"}'),('schema boolean',e||'{"schema":true}'),
 ('schema unsupported',e||'{"schema":2}'),('schema fractional',e||'{"schema":1.5}'),
 ('kind missing',e-'kind'),('kind null',e||'{"kind":null}'),
 ('kind unknown',e||'{"kind":"overwrite"}'),('kind number',e||'{"kind":1}'),
 ('event ID missing',e-'eventId'),('event ID number',e||'{"eventId":1}'),
 ('wrong event ID',e||'{"eventId":"different"}'),
 ('wrong project ID',e||'{"projectId":"22222222-2222-4222-8222-222222222222"}'),
 ('wrong device ID',e||'{"deviceId":"bbbbbbbb-0000-4000-8000-000000000003"}'),
 ('wrong drawing ID',e||'{"drawingId":"another-drawing"}'),
 ('wrong record ID',e||'{"recordId":"another-record"}'),
 ('patch missing',e-'patch'),('patch null',e||'{"patch":null}'),('patch array',e||'{"patch":[]}'),
 ('comments missing',e#-'{patch,comments}'),('fields missing',e#-'{patch,fields}'),
 ('photos missing',e#-'{patch,photos}'),('deletion missing',e#-'{patch,deletion}'),
 ('group wrong type',jsonb_set(e,'{patch,fields}','[]')),
 ('empty patch',e||'{"patch":{"comments":{},"fields":{},"photos":{},"deletion":[]}}'),
 ('entry string',jsonb_set(e,'{patch,comments,c}','"legacy-invalid-fixture"')),
 ('entry revisions missing',e#-'{patch,comments,c,revisions}'),
 ('entry revisions object',jsonb_set(e,'{patch,comments,c,revisions}','{}')),
 ('entry revisions empty',jsonb_set(e,'{patch,comments,c,revisions}','[]')),
 ('order missing',e#-'{patch,comments,c,order}'),
 ('order string',jsonb_set(e,'{patch,comments,c,order}','"1"')),
 ('order negative',jsonb_set(e,'{patch,comments,c,order}','-1')),
 ('order fractional',jsonb_set(e,'{patch,comments,c,order}','0.5')),
 ('order unsafe integer',jsonb_set(e,'{patch,comments,c,order}','9007199254740992')),
 ('revision null',jsonb_set(e,'{patch,comments,c,revisions,0}','null')),
 ('revision ID missing',e#-'{patch,comments,c,revisions,0,id}'),
 ('revision ID empty',jsonb_set(e,'{patch,comments,c,revisions,0,id}','""')),
 ('revision ID long',jsonb_set(e,'{patch,comments,c,revisions,0,id}',to_jsonb(repeat('x',513)))),
 ('revision ID UTF16 limit',jsonb_set(e,'{patch,comments,c,revisions,0,id}',to_jsonb(repeat('🙂',257)))),
 ('parents missing',e#-'{patch,comments,c,revisions,0,parents}'),
 ('parents object',jsonb_set(e,'{patch,comments,c,revisions,0,parents}','{}')),
 ('parents nonstring',jsonb_set(e,'{patch,comments,c,revisions,0,parents}','[1]')),
 ('parents duplicate',jsonb_set(e,'{patch,comments,c,revisions,0,parents}','["p","p"]')),
 ('parent self cycle',jsonb_set(e,'{patch,comments,c,revisions,0,parents}','["revision:adversarial"]')),
 ('actor missing',e#-'{patch,comments,c,revisions,0,actor}'),
 ('actor name missing',e#-'{patch,comments,c,revisions,0,actor,deviceName}'),
 ('actor device missing',e#-'{patch,comments,c,revisions,0,actor,deviceId}'),
 ('actor device invalid',jsonb_set(e,'{patch,comments,c,revisions,0,actor,deviceId}','1')),
 ('time missing',e#-'{patch,comments,c,revisions,0,at}'),
 ('time string',jsonb_set(e,'{patch,comments,c,revisions,0,at}','"1"')),
 ('time negative',jsonb_set(e,'{patch,comments,c,revisions,0,at}','-1')),
 ('time nonfinite in JS',jsonb_set(e,'{patch,comments,c,revisions,0,at}','1e309')),
 ('comment text nonstring',jsonb_set(e,'{patch,comments,c,revisions,0,text}','[]')),
 ('comment deleted nonboolean',jsonb_set(e,'{patch,comments,c,revisions,0,deleted}','"false"')),
 ('UTF8 byte limit',jsonb_set(e,'{patch,comments,c,revisions,0,text}',to_jsonb(repeat('写',90000))))
) cases(label,envelope);

-- Build representative field, photo, deletion and create events from the same
-- immutable revision envelope used by the client, not fake string entries.
CREATE TEMP TABLE delta_valid_shapes(name text PRIMARY KEY,envelope jsonb);
DO $test$
DECLARE e jsonb:=public.test_event('adversarial'); r jsonb; p jsonb;
BEGIN
 r:=e#>'{patch,comments,c,revisions,0}';
 p:='{"comments":{},"fields":{"crackWidthMm":{"revisions":[]}},"photos":{},"deletion":[]}';
 p:=jsonb_set(p,'{fields,crackWidthMm,revisions}',jsonb_build_array((r-'text'-'deleted')||'{"value":0.3}'));
 INSERT INTO delta_valid_shapes VALUES('field',e||jsonb_build_object('patch',p));
 p:='{"comments":{},"fields":{},"photos":{"photo-1":{"revisions":[]}},"deletion":[]}';
 p:=jsonb_set(p,'{photos,photo-1,revisions}',jsonb_build_array((r-'text')||jsonb_build_object('value',
   jsonb_build_object('id','photo-1','name','写真.jpg','size',12,'sha256',repeat('a',64)))));
 INSERT INTO delta_valid_shapes VALUES('photo',e||jsonb_build_object('patch',p));
 p:='{"comments":{},"fields":{},"photos":{},"deletion":[]}';
 p:=jsonb_set(p,'{deletion}',jsonb_build_array((r-'text')||'{"observed":[]}'));
 INSERT INTO delta_valid_shapes VALUES('deletion',e||jsonb_build_object('patch',p));
 p:='{"id":"survey-1","collab":{"version":1,"comments":{},"fields":{},"photos":{},"deletion":{"revisions":[]}}}';
 p:=jsonb_set(p,'{collab,deletion,revisions}',jsonb_build_array((r-'text')||'{"observed":[]}'));
 INSERT INTO delta_valid_shapes VALUES('create',(e-'patch')||jsonb_build_object('kind','create','record',p));
END $test$;

WITH shapes AS (SELECT
 (SELECT envelope FROM delta_valid_shapes WHERE name='field') f,
 (SELECT envelope FROM delta_valid_shapes WHERE name='photo') p,
 (SELECT envelope FROM delta_valid_shapes WHERE name='deletion') d,
 (SELECT envelope FROM delta_valid_shapes WHERE name='create') c)
INSERT INTO delta_rejected_cases
SELECT label,envelope FROM shapes CROSS JOIN LATERAL (VALUES
 ('field value missing',f#-'{patch,fields,crackWidthMm,revisions,0,value}'),
 ('field unset wrong type',jsonb_set(f,'{patch,fields,crackWidthMm,revisions,0,unset}','"true"')),
 ('reserved field name',jsonb_set(f,'{patch,fields}',jsonb_build_object('memo',f#>'{patch,fields,crackWidthMm}'))),
 ('geometry value nonobject',jsonb_set(f,'{patch,fields}',jsonb_build_object('geometry',f#>'{patch,fields,crackWidthMm}'))),
 ('geometry unknown key',jsonb_set(jsonb_set(f,'{patch,fields}',jsonb_build_object('geometry',f#>'{patch,fields,crackWidthMm}')),
   '{patch,fields,geometry,revisions,0,value}','{"unexpected":1}')),
 ('photo wrong ID',jsonb_set(p,'{patch,photos,photo-1,revisions,0,value,id}','"other-photo"')),
 ('photo missing value',p#-'{patch,photos,photo-1,revisions,0,value}'),
 ('photo size negative',jsonb_set(p,'{patch,photos,photo-1,revisions,0,value,size}','-1')),
 ('photo size unsafe',jsonb_set(p,'{patch,photos,photo-1,revisions,0,value,size}','9007199254740992')),
 ('photo size fractional',jsonb_set(p,'{patch,photos,photo-1,revisions,0,value,size}','1.1')),
 ('photo hash malformed',jsonb_set(p,'{patch,photos,photo-1,revisions,0,value,sha256}','"not-a-hash"')),
 ('photo data key',jsonb_set(p,'{patch,photos,photo-1,revisions,0,value,data}','"raw bytes"')),
 ('photo blob key',jsonb_set(p,'{patch,photos,photo-1,revisions,0,value,localBlob}','{}')),
 ('photo nested binary',jsonb_set(p,'{patch,photos,photo-1,revisions,0,value,extra}','{"nested":{"bytes":[1,2]}}')),
 ('photo embedded data URL',jsonb_set(p,'{patch,photos,photo-1,revisions,0,value,url}','"data:image/png;base64,AAA="')),
 ('photo uppercase embedded data URL',jsonb_set(p,'{patch,photos,photo-1,revisions,0,value,url}','"DATA:image/png;base64,AAA="')),
 ('generic positive nonfinite number',jsonb_set(f,'{patch,fields,crackWidthMm,revisions,0,value}','1e309')),
 ('generic negative nonfinite number',jsonb_set(f,'{patch,fields,crackWidthMm,revisions,0,value}','-1e309')),
 ('nested nonfinite number',jsonb_set(f,'{patch,fields,crackWidthMm,revisions,0,value}','{"nested":[1e309]}')),
 ('deletion observed missing',d#-'{patch,deletion,0,observed}'),
 ('deletion observed nonstring',jsonb_set(d,'{patch,deletion,0,observed}','[1]')),
 ('deletion decision missing',d#-'{patch,deletion,0,deleted}'),
 ('create record missing',c-'record'),('create wrong record',jsonb_set(c,'{record,id}','"another-record"')),
 ('create collab missing',c#-'{record,collab}'),('create collab wrong version',jsonb_set(c,'{record,collab,version}','2')),
 ('create deletion missing',c#-'{record,collab,deletion}'),
 ('create deletion empty',jsonb_set(c,'{record,collab,deletion,revisions}','[]')),
 ('create group array',jsonb_set(c,'{record,collab,fields}','[]')),
 ('create projected photos nonarray',jsonb_set(c,'{record,photos}','{}')),
 ('create projected photo no ID',jsonb_set(c,'{record,photos}','[{}]')),
 ('create projected photo null',jsonb_set(c,'{record,photos}','[null]')),
 ('create projected photo binary',jsonb_set(c,'{record,photos}','[{"id":"p","data":"raw bytes"}]')),
 ('create projected photo uppercase URL',jsonb_set(c,'{record,photos}','[{"id":"p","url":"DATA:image/png;base64,AAA="}]')),
 ('duplicate revision in one entry',jsonb_set(p,'{patch,photos,photo-1,revisions}',
   jsonb_build_array(p#>'{patch,photos,photo-1,revisions,0}',p#>'{patch,photos,photo-1,revisions,0}'))),
 ('duplicate revision across groups',jsonb_set(public.test_event('adversarial'),'{patch,fields}',f#>'{patch,fields}'))
) cases(label,envelope);
DO $test$
DECLARE value jsonb := '0'; i integer;
BEGIN
 FOR i IN 1..65 LOOP value:=jsonb_build_object('nested',value); END LOOP;
 INSERT INTO delta_rejected_cases VALUES('excessive nesting',
   jsonb_set((SELECT envelope FROM delta_valid_shapes WHERE name='field'),'{patch,fields,crackWidthMm,revisions,0,value}',value));
END $test$;
GRANT SELECT ON delta_rejected_cases,delta_valid_shapes TO authenticated;
DO $test$
DECLARE e jsonb;
BEGIN
 e:=(SELECT envelope FROM delta_valid_shapes WHERE name='field');
 PERFORM sentlog_delta_private.validate_payload(jsonb_set(e,'{patch,fields,crackWidthMm,revisions,0,value}','1.7976931348623157e308'));
 PERFORM sentlog_delta_private.validate_payload(jsonb_set(e,'{patch,fields,crackWidthMm,revisions,0,value}','-1.7976931348623157e308'));
 e:=(SELECT envelope FROM delta_valid_shapes WHERE name='create');
 PERFORM sentlog_delta_private.validate_payload(jsonb_set(e,'{record,photos}',
   '[{"id":"pending-photo","name":"写真（確認が必要）","collabConflict":true}]'));
END $test$;
SELECT 'PASS SQL JSON compatibility: finite positive/negative bounds and pending-photo placeholder' AS result;
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
DO $test$
DECLARE item record; total integer:=0; result jsonb; e jsonb;
BEGIN
  FOR item IN SELECT label,envelope FROM delta_rejected_cases ORDER BY label LOOP
    BEGIN
      PERFORM public.test_delta_reject(item.envelope); total:=total+1;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'case [%] failed: %',item.label,SQLERRM;
    END;
  END LOOP;
  IF (SELECT count(*) FROM public.sentlog_delta_events)<>2 THEN
    RAISE EXCEPTION 'a rejected event was stored';
  END IF;
  FOR item IN SELECT name,envelope FROM delta_valid_shapes LOOP
    e:=item.envelope||jsonb_build_object('eventId','valid-'||item.name);
    result:=public.sentlog_delta_append_v1('11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-0000-4000-8000-000000000001','valid-'||item.name,'drawing-1','survey-1',e);
    IF result->'eventId' IS DISTINCT FROM e->'eventId' OR result->'projectId' IS DISTINCT FROM e->'projectId' OR
      result->'deviceId' IS DISTINCT FROM e->'deviceId' OR result->'drawingId' IS DISTINCT FROM e->'drawingId' OR
      result->'recordId' IS DISTINCT FROM e->'recordId' OR result->'duplicate' IS DISTINCT FROM 'false'::jsonb THEN
      RAISE EXCEPTION 'acknowledgment identity is missing or wrong: %',result;
    END IF;
  END LOOP;
  -- Special keys are legal IDs and must not be interpreted as object prototypes.
  e:=public.test_event('special-keys');
  e:=jsonb_set(e,'{patch,comments}',jsonb_build_object('__proto__',e#>'{patch,comments,c}'));
  PERFORM public.sentlog_delta_append_v1('11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-0000-4000-8000-000000000001','special-keys','drawing-1','survey-1',e);
  -- A comment discussing a data URL is plain text, not an embedded file.
  e:=public.test_event('plain-text','data: という文字列についてのコメント');
  PERFORM public.sentlog_delta_append_v1('11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-0000-4000-8000-000000000001','plain-text','drawing-1','survey-1',e);
END $test$;
RESET ROLE;
SELECT 'PASS SQL adversarial: '||count(*)||' invalid envelopes rejected; 6 valid shapes and bound acknowledgments accepted' AS result
  FROM delta_rejected_cases;

-- All direct mutations and private ledgers remain denied to authenticated apps.
SET ROLE authenticated;
DO $test$
BEGIN
  IF pg_catalog.has_table_privilege('authenticated','public.sentlog_delta_events','INSERT,UPDATE,DELETE') OR
    pg_catalog.has_table_privilege('authenticated','sentlog_delta_private.heads','SELECT,INSERT,UPDATE,DELETE') OR
    pg_catalog.has_function_privilege('authenticated','sentlog_delta_private.validate_payload(jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'a client bypasses the append boundary';
  END IF;
  BEGIN
    DELETE FROM public.sentlog_delta_events WHERE true;
    RAISE EXCEPTION 'direct deletion succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.sentlog_delta_events SET envelope='{}'::jsonb;
    RAISE EXCEPTION 'direct update succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.sentlog_delta_append_v1('44444444-4444-4444-8444-444444444444',
      'aaaaaaaa-0000-4000-8000-000000000001','dormant','drawing-1','survey-1',
      public.test_event('dormant','x','44444444-4444-4444-8444-444444444444'));
    RAISE EXCEPTION 'dormant project accepted delta';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
END $test$;
SELECT pg_catalog.set_config('request.jwt.claim.sub','',false);
DO $test$
BEGIN
  IF (SELECT count(*) FROM public.sentlog_delta_events)<>0 THEN RAISE EXCEPTION 'unauthenticated read leaked'; END IF;
  PERFORM public.test_delta_reject(public.test_event('adversarial'),'28000');
END $test$;
RESET ROLE;
SET ROLE anon;
DO $test$
BEGIN
  BEGIN
    PERFORM * FROM public.sentlog_delta_events;
    RAISE EXCEPTION 'anonymous read succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.sentlog_delta_append_v1(NULL,NULL,NULL,NULL,NULL,NULL);
    RAISE EXCEPTION 'anonymous RPC succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
RESET ROLE;
SELECT 'PASS SQL permissions: direct mutations, private state, dormant mode, anonymous access, empty identity' AS result;

-- The production trigger is deliberately not activated by the schema draft.
-- Attach its full activation shape only to this disposable fixture.
DROP TRIGGER delta_guard_test ON public.sentlog_project_snapshots;
CREATE TRIGGER delta_guard_test BEFORE INSERT OR UPDATE OR DELETE ON public.sentlog_project_snapshots
  FOR EACH ROW EXECUTE FUNCTION sentlog_delta_private.reject_legacy_snapshot();
INSERT INTO public.sentlog_projects(id,owner_id,status)
VALUES('55555555-5555-4555-8555-555555555555','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active');
GRANT INSERT,UPDATE,DELETE ON public.sentlog_project_snapshots TO authenticated;
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
DO $test$
BEGIN
  BEGIN
    INSERT INTO public.sentlog_project_snapshots(project_id,revision)
    VALUES('11111111-1111-4111-8111-111111111111',10);
    RAISE EXCEPTION 'legacy insert accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    DELETE FROM public.sentlog_project_snapshots WHERE project_id='11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'legacy deletion accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    UPDATE public.sentlog_project_snapshots SET project_id='55555555-5555-4555-8555-555555555555'
    WHERE project_id='11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'legacy move from enabled project accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    UPDATE public.sentlog_project_snapshots SET project_id='11111111-1111-4111-8111-111111111111'
    WHERE project_id='44444444-4444-4444-8444-444444444444';
    RAISE EXCEPTION 'legacy move into enabled project accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  INSERT INTO public.sentlog_project_snapshots(project_id,revision)
  VALUES('55555555-5555-4555-8555-555555555555',1);
  UPDATE public.sentlog_project_snapshots SET revision=2 WHERE project_id='55555555-5555-4555-8555-555555555555';
  DELETE FROM public.sentlog_project_snapshots WHERE project_id='55555555-5555-4555-8555-555555555555';
  IF EXISTS(SELECT 1 FROM public.sentlog_project_snapshots WHERE project_id='55555555-5555-4555-8555-555555555555') THEN
    RAISE EXCEPTION 'non-migrated project CRUD regressed';
  END IF;
END $test$;
RESET ROLE;
SELECT 'PASS SQL legacy: enabled INSERT/UPDATE/DELETE and project moves refused; non-migrated CRUD preserved' AS result;

-- Dedupe IDs are account-wide, and the wire cursor must remain a JavaScript
-- safe integer. Rejected operations may not move either project's head.
UPDATE sentlog_delta_private.heads SET enabled=true,activated_at=now()
 WHERE project_id='44444444-4444-4444-8444-444444444444';
UPDATE public.sentlog_devices SET active=true WHERE id='aaaaaaaa-0000-4000-8000-000000000002';
INSERT INTO sentlog_delta_private.heads(project_id,owner_id)
 VALUES('55555555-5555-4555-8555-555555555555','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
DO $test$
BEGIN
 IF (SELECT enabled FROM sentlog_delta_private.heads WHERE project_id='55555555-5555-4555-8555-555555555555') THEN
   RAISE EXCEPTION 'new heads must default to disabled';
 END IF;
END $test$;
SET ROLE authenticated;
DO $test$
BEGIN
 BEGIN
  PERFORM public.sentlog_delta_append_v1('44444444-4444-4444-8444-444444444444',
   'aaaaaaaa-0000-4000-8000-000000000001','event-1','drawing-1','survey-1',
   public.test_event('event-1','value','44444444-4444-4444-8444-444444444444'));
  RAISE EXCEPTION 'same-account cross-project event ID reused';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
  PERFORM public.sentlog_delta_append_v1('11111111-1111-4111-8111-111111111111',
   'aaaaaaaa-0000-4000-8000-000000000002','event-1','drawing-1','survey-1',
   public.test_event('event-1','value','11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000002'));
  RAISE EXCEPTION 'same-account event replay from another device accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
  PERFORM public.sentlog_delta_append_v1('55555555-5555-4555-8555-555555555555',
   'aaaaaaaa-0000-4000-8000-000000000001','disabled-default','drawing-1','survey-1',
   public.test_event('disabled-default','value','55555555-5555-4555-8555-555555555555'));
  RAISE EXCEPTION 'default-disabled project accepted append';
 EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
END $test$;
RESET ROLE;
CREATE TEMP TABLE delta_head_before AS SELECT last_seq FROM sentlog_delta_private.heads
 WHERE project_id='11111111-1111-4111-8111-111111111111';
UPDATE sentlog_delta_private.heads SET last_seq=9007199254740991
 WHERE project_id='11111111-1111-4111-8111-111111111111';
SET ROLE authenticated;
SELECT public.test_delta_reject(public.test_event('adversarial'),'22003');
RESET ROLE;
DO $test$
BEGIN
 IF (SELECT last_seq FROM sentlog_delta_private.heads WHERE project_id='44444444-4444-4444-8444-444444444444')<>0 OR
   (SELECT last_seq FROM sentlog_delta_private.heads WHERE project_id='11111111-1111-4111-8111-111111111111')<>9007199254740991 OR
   (SELECT count(*) FROM public.sentlog_delta_events)<>8 THEN
   RAISE EXCEPTION 'refused collisions or cursor overflow changed committed state';
 END IF;
END $test$;
UPDATE sentlog_delta_private.heads SET last_seq=(SELECT last_seq FROM delta_head_before)
 WHERE project_id='11111111-1111-4111-8111-111111111111';
SELECT 'PASS SQL boundaries: default disabled, cross-project/device ID collisions, safe-integer cursor exhaustion' AS result;
ROLLBACK;
