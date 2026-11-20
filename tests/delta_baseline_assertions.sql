-- All fixtures live in a disposable database. Never run against production.
\set ON_ERROR_STOP on
SELECT public.baseline_assert(NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger
 WHERE tgrelid='public.sentlog_project_snapshots'::regclass AND tgname='delta_baseline_test_legacy_guard'),
 'install does not create a legacy-write trigger');
SELECT public.baseline_assert(NOT pg_catalog.has_function_privilege('authenticated',
 'sentlog_delta_private.activate_prepared_baseline(uuid,uuid,uuid)','EXECUTE') AND
 NOT pg_catalog.has_function_privilege('anon','public.sentlog_delta_prepare_baseline_v1(uuid,uuid,bigint)','EXECUTE') AND
 NOT pg_catalog.has_table_privilege('authenticated','sentlog_delta_private.baselines','SELECT,INSERT,UPDATE,DELETE') AND
 NOT pg_catalog.has_table_privilege('authenticated','sentlog_delta_private.baseline_records','SELECT,INSERT,UPDATE,DELETE'),
 'activation and internal ledgers have no client privileges');

SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
DO $test$
DECLARE a jsonb; b jsonb; page jsonb; q text; bid uuid; manifest_text text;
  pid constant uuid:='77000000-0000-4000-8000-000000000001';
  did constant uuid:='aaaaaaaa-0000-4000-8000-000000000001';
BEGIN
  a:=public.sentlog_delta_prepare_baseline_v1(pid,did,10);bid:=(a->>'baselineId')::uuid;
  PERFORM public.baseline_assert(a->>'state'='prepared' AND a->>'cursor'='0' AND
    a->>'recordCount'='3' AND a->>'importedCount'='0' AND a->>'deltaEnabled'='false',
    'prepare retains ordinary and deleted records without activating');
  PERFORM public.baseline_assert(a->>'ownerId'='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND
    a->>'projectId'=pid::text AND a->>'snapshotRevision'='10' AND
    a->>'snapshotSha256' ~ '^[0-9a-f]{64}$' AND a->>'manifestSha256' ~ '^[0-9a-f]{64}$' AND
    a->>'hashFormat'='postgres-jsonb-text-sha256-v1' AND a->>'deviceMigrationVerified'='false' AND
    a->>'assetDeliveryVerified'='false','receipt identifies scope, source and verification limits');
  b:=public.sentlog_delta_prepare_baseline_v1(pid,did,10);
  PERFORM public.baseline_assert(a=b,'repeat preparation is exactly idempotent');
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_read_baseline_page_v1(%L,%L,%L)',pid,did,bid),'55000','NOT_VERIFIED',
    'unverified records are not handed to replicas');
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select sentlog_delta_private.activate_prepared_baseline(%L,%L,%L)',pid,did,bid),'42501','permission denied',
    'authenticated client cannot activate even its own project');
  b:=public.sentlog_delta_import_baseline_batch_v1(pid,did,bid,1);
  PERFORM public.baseline_assert(b->>'state'='importing' AND b->>'importedCount'='1' AND
    b->>'deltaEnabled'='false','first bounded batch records resumable progress');
  b:=public.sentlog_delta_import_baseline_batch_v1(pid,did,bid,1);
  PERFORM public.baseline_assert(b->>'importedCount'='2','second batch resumes at the next record');
  b:=public.sentlog_delta_import_baseline_batch_v1(pid,did,bid,1);
  PERFORM public.baseline_assert(b->>'state'='verified' AND b->>'importedCount'='3' AND
    b->>'deltaEnabled'='false','complete server verification still leaves delta disabled');
  a:=public.sentlog_delta_import_baseline_batch_v1(pid,did,bid,100);
  PERFORM public.baseline_assert(a=b,'lost completion response can be retried without duplicate records');
  page:=public.sentlog_delta_read_baseline_page_v1(pid,did,bid,0,1);
  PERFORM public.baseline_assert(pg_catalog.jsonb_array_length(page->'records')=1 AND
    page->>'nextOrdinal'='1' AND page->>'hasMore'='true','record download honors the requested page boundary');
  PERFORM public.baseline_assert(page#>>'{records,0,sha256}'=
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(page#>>'{records,0,recordJson}','UTF8')),'hex'),
    'download hash covers the exact JSON string supplied to a client');
  page:=public.sentlog_delta_read_baseline_page_v1(pid,did,bid,1,1);
  PERFORM public.baseline_assert((page#>>'{records,0,recordJson}')::jsonb#>'{collab,deletion,revisions,0,deleted}'='true'::jsonb,
    'deleted-record history is preserved in a downloadable baseline');
  page:=public.sentlog_delta_read_baseline_page_v1(pid,did,bid,2,100);
  PERFORM public.baseline_assert(page#>>'{records,0,drawingId}'='drawing:2' AND
    page#>>'{records,0,recordId}'='record:1' AND page->>'hasMore'='false',
    'same record ID on another drawing is retained independently');
  page:=public.sentlog_delta_read_baseline_page_v1(pid,did,bid,0,100);
  SELECT '['||pg_catalog.string_agg(r.value->>'manifestEntryJson',', ' ORDER BY (r.value->>'ordinal')::bigint)||']'
    INTO manifest_text FROM pg_catalog.jsonb_array_elements(page->'records') r;
  PERFORM public.baseline_assert(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(manifest_text,'UTF8')),'hex')=
    page#>>'{receipt,manifestSha256}','downloaded manifest entries can independently verify complete record membership');
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_import_baseline_batch_v1(%L,%L,%L,101)',pid,did,bid),'22023','BATCH_LIMIT',
    'unbounded imports are refused');
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_read_baseline_page_v1(%L,%L,%L,-1,100)',pid,did,bid),'22023','PAGE_INVALID',
    'invalid download cursor is refused');
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_prepare_baseline_v1(%L,%L,9)',pid,did),'40001','STALE',
    'preparation rejects a stale snapshot revision');
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_prepare_baseline_v1(%L,%L,10)',pid,'aaaaaaaa-0000-4000-8000-000000000002'),
    '42501','DEVICE_FORBIDDEN','inactive device cannot prepare a baseline');
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_read_baseline_page_v1(%L,%L,%L)',pid,'bbbbbbbb-0000-4000-8000-000000000003',bid),
    '42501','DEVICE_FORBIDDEN','another account device cannot read a baseline');

  a:=public.sentlog_delta_prepare_baseline_v1('77000000-0000-4000-8000-000000000003',did,10);
  bid:=(a->>'baselineId')::uuid;
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_import_baseline_batch_v1(%L,%L,%L,2)',
    '77000000-0000-4000-8000-000000000003',did,bid),'22023','UNKNOWN_PARENT',
    'malformed tombstone rejects its complete batch');
  a:=public.sentlog_delta_prepare_baseline_v1('77000000-0000-4000-8000-000000000003',did,10);
  PERFORM public.baseline_assert(a->>'importedCount'='0' AND a->>'state'='prepared',
    'failed batch cannot commit partial progress');
  a:=public.sentlog_delta_import_baseline_batch_v1('77000000-0000-4000-8000-000000000003',did,bid,1);
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_import_baseline_batch_v1(%L,%L,%L,1)',
    '77000000-0000-4000-8000-000000000003',did,bid),'22023','UNKNOWN_PARENT',
    'retry of malformed record still fails closed');
  a:=public.sentlog_delta_prepare_baseline_v1('77000000-0000-4000-8000-000000000003',did,10);
  PERFORM public.baseline_assert(a->>'importedCount'='1' AND a->>'state'='importing',
    'earlier successful batch survives a later failure');
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_prepare_baseline_v1(%L,%L,10)',
    '77000000-0000-4000-8000-000000000004',did),'23505','unique',
    'duplicate ID in active and deleted arrays is rejected');
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_prepare_baseline_v1(%L,%L,10)',
    '77000000-0000-4000-8000-000000000005',did),'22023','COLLAB_SNAPSHOT_REQUIRED',
    'legacy snapshot without immutable history is not auto-upgraded');
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_prepare_baseline_v1(%L,%L,10)',
    '77000000-0000-4000-8000-000000000007',did),'22023','DRAWING_STATE_REQUIRED',
    'missing drawing state is never converted into an empty drawing');
  a:=public.sentlog_delta_prepare_baseline_v1('77000000-0000-4000-8000-000000000006',did,10);
  page:=public.sentlog_delta_read_baseline_page_v1('77000000-0000-4000-8000-000000000006',did,(a->>'baselineId')::uuid);
  PERFORM public.baseline_assert(a->>'state'='verified' AND a->>'recordCount'='0' AND
    page->'records'='[]'::jsonb AND page->>'hasMore'='false' AND a->>'deltaEnabled'='false',
    'explicit empty snapshot is valid and still not activated');
  a:=public.sentlog_delta_prepare_baseline_v1('77000000-0000-4000-8000-000000000008',did,10);
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_import_baseline_batch_v1(%L,%L,%L,1)',
    '77000000-0000-4000-8000-000000000008',did,a->>'baselineId'),'22023','PAYLOAD_INVALID',
    'unsupported large single record is retained without activation');
  a:=public.sentlog_delta_prepare_baseline_v1('77000000-0000-4000-8000-000000000002',did,10);
  PERFORM public.sentlog_delta_import_baseline_batch_v1('77000000-0000-4000-8000-000000000002',did,(a->>'baselineId')::uuid);
END $test$;

SELECT pg_catalog.set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',false);
SELECT public.baseline_expect_error($sql$SELECT public.sentlog_delta_prepare_baseline_v1(
 '77000000-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000003',10)$sql$,
 '42501','PROJECT_FORBIDDEN','another account cannot access the project');
SELECT pg_catalog.set_config('request.jwt.claim.sub','',false);
SELECT public.baseline_expect_error($sql$SELECT public.sentlog_delta_prepare_baseline_v1(
 '77000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001',10)$sql$,
 '28000','LOGIN_REQUIRED','missing authentication cannot access the baseline');
RESET ROLE;
SELECT pg_catalog.set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);

SELECT public.baseline_assert(NOT EXISTS(SELECT 1 FROM sentlog_delta_private.heads WHERE enabled AND project_id::text LIKE '77000000-%')
 AND NOT EXISTS(SELECT 1 FROM public.sentlog_delta_events WHERE project_id::text LIKE '77000000-%')
 AND NOT EXISTS(SELECT 1 FROM sentlog_delta_private.record_states WHERE project_id::text LIKE '77000000-%')
 AND NOT EXISTS(SELECT 1 FROM realtime.test_messages WHERE message#>>'{payload,project_id}' LIKE '77000000-%'),
 'staging writes no live record state, events, sequence numbers or broadcasts');
SELECT public.baseline_assert(NOT EXISTS(SELECT 1 FROM sentlog_delta_private.baselines
 WHERE project_id='77000000-0000-4000-8000-000000000004') AND
 NOT EXISTS(SELECT 1 FROM sentlog_delta_private.heads WHERE project_id='77000000-0000-4000-8000-000000000004'),
 'failed preparation rolls back its head and copied snapshot');
SELECT public.baseline_assert((SELECT snapshot=public.baseline_test_payload('baseline-client-1')
 FROM sentlog_delta_private.baselines WHERE project_id='77000000-0000-4000-8000-000000000001'),
 'complete snapshot retains drawing, scale, rotation and PDF metadata');
SELECT public.baseline_expect_error(pg_catalog.format(
 'select sentlog_delta_private.activate_prepared_baseline(%L,%L,%L)',project_id,
 'aaaaaaaa-0000-4000-8000-000000000001',id),'55000','LEGACY_GUARD_REQUIRED',
 'activation refuses an absent legacy-write guard') FROM sentlog_delta_private.baselines
 WHERE project_id='77000000-0000-4000-8000-000000000001';

-- Only the DISPOSABLE test installs this trigger. The candidate module does not.
CREATE TRIGGER delta_baseline_test_legacy_guard BEFORE INSERT OR UPDATE OR DELETE
 ON public.sentlog_project_snapshots FOR EACH ROW
 EXECUTE FUNCTION sentlog_delta_private.reject_legacy_snapshot();
SELECT public.baseline_expect_error(pg_catalog.format(
 'select sentlog_delta_private.activate_prepared_baseline(%L,%L,%L)',project_id,
 'aaaaaaaa-0000-4000-8000-000000000001',id),'55000','ACTIVATION_UNSAFE',
 'partial import cannot be activated even by the test operator') FROM sentlog_delta_private.baselines
 WHERE project_id='77000000-0000-4000-8000-000000000003';

-- A legacy save between batches and activation invalidates the original source.
UPDATE public.sentlog_project_snapshots SET revision=11,
 payload=pg_catalog.jsonb_set(payload,'{project,name}','"old client saved after prepare"'::jsonb)
 WHERE project_id='77000000-0000-4000-8000-000000000002';
SELECT public.baseline_expect_error(pg_catalog.format(
 'select sentlog_delta_private.activate_prepared_baseline(%L,%L,%L)',project_id,
 'aaaaaaaa-0000-4000-8000-000000000001',id),'40001','STALE',
 'old save after preparation prevents activation') FROM sentlog_delta_private.baselines
 WHERE project_id='77000000-0000-4000-8000-000000000002';
SELECT public.baseline_assert(NOT (SELECT enabled FROM sentlog_delta_private.heads
 WHERE project_id='77000000-0000-4000-8000-000000000002') AND
 (SELECT payload#>>'{project,name}'='old client saved after prepare' FROM public.sentlog_project_snapshots
 WHERE project_id='77000000-0000-4000-8000-000000000002'),
 'stale activation preserves the old client save and keeps delta disabled');

SET ROLE authenticated;
DO $test$
DECLARE a jsonb; b jsonb;
BEGIN
 a:=public.sentlog_delta_prepare_baseline_v1('77000000-0000-4000-8000-000000000002',
  'aaaaaaaa-0000-4000-8000-000000000001',11);
 b:=public.sentlog_delta_import_baseline_batch_v1('77000000-0000-4000-8000-000000000002',
  'aaaaaaaa-0000-4000-8000-000000000001',(a->>'baselineId')::uuid,100);
 PERFORM public.baseline_assert(b->>'snapshotRevision'='11' AND b->>'state'='verified',
  'new snapshot revision can be staged independently');
END $test$;
RESET ROLE;
SELECT public.baseline_assert((SELECT count(*)=2 FROM sentlog_delta_private.baselines
 WHERE project_id='77000000-0000-4000-8000-000000000002'),
 'restaging preserves the earlier snapshot and its verified records');

DO $test$
DECLARE b sentlog_delta_private.baselines%ROWTYPE; a jsonb; repeated jsonb;
BEGIN
 SELECT * INTO b FROM sentlog_delta_private.baselines WHERE project_id='77000000-0000-4000-8000-000000000001';
 a:=sentlog_delta_private.activate_prepared_baseline(b.project_id,'aaaaaaaa-0000-4000-8000-000000000001',b.id);
 PERFORM public.baseline_assert(a->>'state'='active' AND a->>'deltaEnabled'='true' AND a->>'cursor'='0',
  'privileged activation commits a verified baseline at cursor zero');
 repeated:=sentlog_delta_private.activate_prepared_baseline(b.project_id,'aaaaaaaa-0000-4000-8000-000000000001',b.id);
 PERFORM public.baseline_assert(a=repeated,'activation retry is idempotent');
 PERFORM public.baseline_assert((SELECT count(*)=3 FROM sentlog_delta_private.record_states WHERE project_id=b.project_id)
   AND NOT EXISTS(SELECT 1 FROM public.sentlog_delta_events WHERE project_id=b.project_id)
   AND NOT EXISTS(SELECT 1 FROM realtime.test_messages WHERE message#>>'{payload,project_id}'=b.project_id::text),
   'activation initializes all record graphs without fake change events');
END $test$;
SELECT public.baseline_expect_error($sql$UPDATE public.sentlog_project_snapshots SET revision=11
 WHERE project_id='77000000-0000-4000-8000-000000000001'$sql$,
 '55000','UPGRADE_REQUIRED','legacy writes are rejected after activation');

SET ROLE authenticated;
DO $test$
DECLARE e jsonb; result jsonb; receipt jsonb;
BEGIN
 e:=pg_catalog.jsonb_build_object('schema',1,'eventId','baseline-followup',
  'projectId','77000000-0000-4000-8000-000000000001',
  'deviceId','aaaaaaaa-0000-4000-8000-000000000001','drawingId','drawing:1','recordId','record:1','kind','patch',
  'patch',pg_catalog.jsonb_build_object('comments','{}'::jsonb,'photos','{}'::jsonb,'deletion','[]'::jsonb,
    'fields',pg_catalog.jsonb_build_object('member',pg_catalog.jsonb_build_object('revisions',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id','after-baseline',
       'parents','["member-root:record:1"]'::jsonb,
       'actor',pg_catalog.jsonb_build_object('deviceId','aaaaaaaa-0000-4000-8000-000000000001','deviceName','phone'),
       'at',1,'value','wall'))))));
 result:=public.sentlog_delta_append_v1('77000000-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000001','baseline-followup','drawing:1','record:1',e);
 PERFORM public.baseline_assert(result->>'seq'='1' AND result->>'duplicate'='false',
  'first delta can reference the imported immutable parent');
 receipt:=public.sentlog_delta_prepare_baseline_v1('77000000-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000001',10);
 PERFORM public.baseline_assert(receipt->>'state'='active' AND receipt->>'cursor'='0',
  'retrying preparation after edits returns the original baseline');
END $test$;
RESET ROLE;
DO $test$
DECLARE b sentlog_delta_private.baselines%ROWTYPE;
BEGIN
 SELECT * INTO b FROM sentlog_delta_private.baselines WHERE project_id='77000000-0000-4000-8000-000000000001';
 PERFORM sentlog_delta_private.activate_prepared_baseline(b.project_id,'aaaaaaaa-0000-4000-8000-000000000001',b.id);
 PERFORM public.baseline_assert((SELECT last_seq=1 FROM sentlog_delta_private.heads WHERE project_id=b.project_id)
   AND (SELECT pg_catalog.jsonb_array_length(collab#>'{fields,member,revisions}')=2
     FROM sentlog_delta_private.record_states WHERE project_id=b.project_id AND drawing_id='drawing:1' AND record_id='record:1')
   AND (SELECT pg_catalog.jsonb_array_length(collab#>'{fields,member,revisions}')=1
     FROM sentlog_delta_private.record_states WHERE project_id=b.project_id AND drawing_id='drawing:2' AND record_id='record:1'),
   'activation retry never rewrites accepted edits or the other drawing');
END $test$;

-- Same revision with altered data must not reuse a saved baseline silently.
UPDATE public.sentlog_project_snapshots SET payload=pg_catalog.jsonb_set(payload,'{project,name}','"same revision changed"'::jsonb)
 WHERE project_id='77000000-0000-4000-8000-000000000002';
SET ROLE authenticated;
SELECT public.baseline_expect_error($sql$SELECT public.sentlog_delta_prepare_baseline_v1(
 '77000000-0000-4000-8000-000000000002','aaaaaaaa-0000-4000-8000-000000000001',11)$sql$,
 '22023','REVISION_REUSED','same revision with changed payload cannot reuse a baseline');
RESET ROLE;
-- Non-record metadata is a separate exact-byte contract, including empty
-- drawings, the local/cloud project mapping and settings omitted by records.
SELECT public.baseline_assert(NOT pg_catalog.has_function_privilege('anon',
 'public.sentlog_delta_read_baseline_metadata_page_v1(uuid,uuid,uuid,bigint,integer)','EXECUTE'),
 'metadata pages are not callable by anonymous clients');
SET ROLE authenticated;
DO $test$
DECLARE a jsonb; page jsonb; all_pages jsonb; item jsonb; manifest_text text; bid uuid;
  pid constant uuid:='77000000-0000-4000-8000-000000000001';
  did constant uuid:='aaaaaaaa-0000-4000-8000-000000000001';
BEGIN
  a:=public.sentlog_delta_prepare_baseline_v1(pid,did,10);bid:=(a->>'baselineId')::uuid;
  PERFORM public.baseline_assert(a->>'clientProjectId'='baseline-client-1' AND
    a->'drawingIds'='["drawing:1","drawing:2"]'::jsonb AND a->>'metadataCount'='3' AND
    a->>'metadataManifestSha256' ~ '^[0-9a-f]{64}$',
    'receipt binds the client project ID and complete drawing metadata membership');
  page:=public.sentlog_delta_read_baseline_metadata_page_v1(pid,did,bid,0,1);
  PERFORM public.baseline_assert(page->'receipt'=a AND page->>'nextOrdinal'='1' AND page->>'hasMore'='true' AND
    pg_catalog.jsonb_array_length(page->'metadata')=1 AND page#>>'{metadata,0,kind}'='header' AND
    page#>>'{metadata,0,key}'='project' AND
    NOT ((page#>>'{metadata,0,metadataJson}')::jsonb ? 'drawings') AND
    (page#>>'{metadata,0,metadataJson}')::jsonb#>>'{project,id}'='baseline-client-1',
    'metadata header retains project information without record drawing envelopes');
  page:=public.sentlog_delta_read_baseline_metadata_page_v1(pid,did,bid,1,1);
  item:=(page#>>'{metadata,0,metadataJson}')::jsonb;
  PERFORM public.baseline_assert(page->>'nextOrdinal'='2' AND page->>'hasMore'='true' AND
    page#>>'{metadata,0,kind}'='drawing' AND page#>>'{metadata,0,key}'='drawing:1' AND
    item#>>'{meta,pdfFileId}'='drawing-pdf' AND item#>>'{state,rotation}'='90' AND
    item#>>'{state,scale}'='0.01' AND NOT (item->'state' ? 'shapes') AND
    NOT (item->'state' ? 'collabDeletedRecords'),
    'metadata keeps file references rotation and scale while excluding both record arrays');
  page:=public.sentlog_delta_read_baseline_metadata_page_v1(pid,did,bid,2,1);
  PERFORM public.baseline_assert(page#>>'{metadata,0,key}'='drawing:2' AND
    page->>'nextOrdinal'='3' AND page->>'hasMore'='false','metadata final page terminates at its exact ordinal');
  page:=public.sentlog_delta_read_baseline_metadata_page_v1(pid,did,bid,3,1);
  PERFORM public.baseline_assert(page->'metadata'='[]'::jsonb AND page->>'nextOrdinal'='3' AND
    page->>'hasMore'='false','metadata end cursor returns an explicit empty page');
  all_pages:=public.sentlog_delta_read_baseline_metadata_page_v1(pid,did,bid,0,100);
  PERFORM public.baseline_assert(NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(all_pages->'metadata') r
    WHERE r.value->>'sha256' IS DISTINCT FROM pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(r.value->>'metadataJson','UTF8')),'hex') OR
      (r.value->>'manifestEntryJson')::jsonb IS DISTINCT FROM pg_catalog.jsonb_build_object(
        'ordinal',r.value->'ordinal','kind',r.value->'kind','key',r.value->'key','sha256',r.value->'sha256')),
    'each metadata digest covers its exact emitted JSON and manifest identity');
  SELECT '['||pg_catalog.string_agg(r.value->>'manifestEntryJson',', ' ORDER BY (r.value->>'ordinal')::bigint)||']'
    INTO manifest_text FROM pg_catalog.jsonb_array_elements(all_pages->'metadata') r;
  PERFORM public.baseline_assert(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(manifest_text,'UTF8')),'hex')=
    a->>'metadataManifestSha256','complete metadata manifest verifies independently from record membership');
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_read_baseline_metadata_page_v1(%L,%L,%L,-1,100)',pid,did,bid),
    '22023','PAGE_INVALID','metadata negative cursor is rejected');
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_read_baseline_metadata_page_v1(%L,%L,%L,4,100)',pid,did,bid),
    '22023','PAGE_INVALID','metadata cursor beyond the complete manifest is rejected');
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_read_baseline_metadata_page_v1(%L,%L,%L,0,101)',pid,did,bid),
    '22023','PAGE_INVALID','unbounded metadata page requests are rejected');
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_read_baseline_metadata_page_v1(%L,%L,%L,0,0)',pid,did,bid),
    '22023','PAGE_INVALID','zero metadata page size is rejected');
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_read_baseline_metadata_page_v1(%L,%L,%L)',pid,
    'aaaaaaaa-0000-4000-8000-000000000002',bid),'42501','DEVICE_FORBIDDEN','inactive devices cannot read metadata');
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_read_baseline_metadata_page_v1(%L,%L,%L)',pid,
    'bbbbbbbb-0000-4000-8000-000000000003',bid),'42501','DEVICE_FORBIDDEN','foreign account devices cannot read metadata');
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_read_baseline_metadata_page_v1(%L,%L,%L)',
    '77000000-0000-4000-8000-000000000006',did,bid),'55000','NOT_VERIFIED','metadata cannot reuse a baseline from another project');
  a:=public.sentlog_delta_prepare_baseline_v1('77000000-0000-4000-8000-000000000003',did,10);
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_read_baseline_metadata_page_v1(%L,%L,%L)',
    '77000000-0000-4000-8000-000000000003',did,a->>'baselineId'),'55000','NOT_VERIFIED','partial imports do not expose metadata');
  PERFORM pg_catalog.set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',false);
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_read_baseline_metadata_page_v1(%L,%L,%L)',pid,did,bid),
    '42501','PROJECT_FORBIDDEN','foreign accounts cannot read metadata');
  PERFORM pg_catalog.set_config('request.jwt.claim.sub','',false);
  PERFORM public.baseline_expect_error(pg_catalog.format(
    'select public.sentlog_delta_read_baseline_metadata_page_v1(%L,%L,%L)',pid,did,bid),
    '28000','LOGIN_REQUIRED','missing authenticated identity cannot read metadata');
  PERFORM pg_catalog.set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
END $test$;
RESET ROLE;

-- A mapping or device change between pages must be checked again on the RPC.
UPDATE public.sentlog_projects SET client_key='changed-after-metadata-page'
 WHERE id='77000000-0000-4000-8000-000000000001';
DO $test$
DECLARE bid uuid;
BEGIN
 SELECT id INTO bid FROM sentlog_delta_private.baselines WHERE project_id='77000000-0000-4000-8000-000000000001';
 PERFORM public.baseline_expect_error(pg_catalog.format(
  'select public.sentlog_delta_read_baseline_metadata_page_v1(%L,%L,%L,1,1)',
  '77000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001',bid),
  '55000','BINDING_CHANGED','metadata cannot cross a changed local project mapping');
 PERFORM public.baseline_expect_error(pg_catalog.format(
  'select public.sentlog_delta_read_baseline_page_v1(%L,%L,%L,1,1)',
  '77000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001',bid),
  '55000','BINDING_CHANGED','record pages also refuse a changed local project mapping');
END $test$;
UPDATE public.sentlog_projects SET client_key='baseline-client-1'
 WHERE id='77000000-0000-4000-8000-000000000001';
UPDATE public.sentlog_devices SET active=false WHERE id='aaaaaaaa-0000-4000-8000-000000000001';
DO $test$
DECLARE bid uuid;
BEGIN
 SELECT id INTO bid FROM sentlog_delta_private.baselines WHERE project_id='77000000-0000-4000-8000-000000000001';
 PERFORM public.baseline_expect_error(pg_catalog.format(
  'select public.sentlog_delta_read_baseline_metadata_page_v1(%L,%L,%L,1,1)',
  '77000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001',bid),
  '42501','DEVICE_FORBIDDEN','metadata rereads reject a device stopped between pages');
END $test$;
UPDATE public.sentlog_devices SET active=true WHERE id='aaaaaaaa-0000-4000-8000-000000000001';

UPDATE public.sentlog_project_snapshots SET payload=pg_catalog.jsonb_build_object(
 'project',pg_catalog.jsonb_build_object('id','baseline-client-9','collaborationVersion',1,'name','empty drawing',
   'drawings','[{"id":"empty-drawing","name":"settings remain"}]'::jsonb),
 'drawings','[{"meta":{"id":"empty-drawing","name":"settings remain"},"state":{"shapes":[],"collabDeletedRecords":[],"scale":0.02,"rotation":270}}]'::jsonb)
 WHERE project_id='77000000-0000-4000-8000-000000000009';
SET ROLE authenticated;
DO $test$
DECLARE a jsonb; page jsonb;
BEGIN
 a:=public.sentlog_delta_prepare_baseline_v1('77000000-0000-4000-8000-000000000009','aaaaaaaa-0000-4000-8000-000000000001',10);
 page:=public.sentlog_delta_read_baseline_metadata_page_v1('77000000-0000-4000-8000-000000000009',
   'aaaaaaaa-0000-4000-8000-000000000001',(a->>'baselineId')::uuid,1,1);
 PERFORM public.baseline_assert(a->>'recordCount'='0' AND a->>'metadataCount'='2' AND a->'drawingIds'='["empty-drawing"]'::jsonb AND
   page#>>'{metadata,0,key}'='empty-drawing' AND (page#>>'{metadata,0,metadataJson}')::jsonb#>>'{state,rotation}'='270',
   'empty drawings retain their authenticated metadata without any record rows');
 a:=public.sentlog_delta_prepare_baseline_v1('77000000-0000-4000-8000-000000000006','aaaaaaaa-0000-4000-8000-000000000001',10);
 page:=public.sentlog_delta_read_baseline_metadata_page_v1('77000000-0000-4000-8000-000000000006',
   'aaaaaaaa-0000-4000-8000-000000000001',(a->>'baselineId')::uuid,0,100);
 PERFORM public.baseline_assert(a->>'metadataCount'='1' AND a->'drawingIds'='[]'::jsonb AND
   page->>'hasMore'='false' AND pg_catalog.jsonb_array_length(page->'metadata')=1,
   'an entirely empty project still has a verifiable metadata header');
END $test$;
RESET ROLE;
UPDATE public.sentlog_project_snapshots SET revision=11,payload=pg_catalog.jsonb_set(payload,
 '{drawings,0,state,largeSetting}',pg_catalog.to_jsonb(repeat('m',910000)))
 WHERE project_id='77000000-0000-4000-8000-000000000009';
SET ROLE authenticated;
DO $test$
DECLARE a jsonb;
BEGIN
 a:=public.sentlog_delta_prepare_baseline_v1('77000000-0000-4000-8000-000000000009','aaaaaaaa-0000-4000-8000-000000000001',11);
 PERFORM public.baseline_expect_error(pg_catalog.format(
  'select public.sentlog_delta_read_baseline_metadata_page_v1(%L,%L,%L,1,1)',
  '77000000-0000-4000-8000-000000000009','aaaaaaaa-0000-4000-8000-000000000001',a->>'baselineId'),
  '54000','PAGE_TOO_LARGE','oversized metadata fails explicitly without truncating its content');
 PERFORM public.baseline_assert(a->>'deltaEnabled'='false' AND a->>'state'='verified',
  'unsupported metadata capacity never enables synchronization');
END $test$;
RESET ROLE;
UPDATE public.sentlog_project_snapshots SET revision=12,payload=pg_catalog.jsonb_set(payload,
 '{drawings,0,meta,id}','"mismatched-drawing"'::jsonb)
 WHERE project_id='77000000-0000-4000-8000-000000000009';
SET ROLE authenticated;
SELECT public.baseline_expect_error($sql$SELECT public.sentlog_delta_prepare_baseline_v1(
 '77000000-0000-4000-8000-000000000009','aaaaaaaa-0000-4000-8000-000000000001',12)$sql$,
 '22023','DRAWINGS_MISMATCH','mismatched metadata drawing membership cannot prepare a baseline');
RESET ROLE;
SELECT 'PASS baseline: '||count(*)||' checks; scoped staging, bounded resume, tombstones, atomic activation and stale-source rejection' AS result
 FROM public.baseline_test_results;
