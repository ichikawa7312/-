-- Disposable database fixture only; every mutation is rolled back. The only
-- returned row is the real SQL receipt and pages consumed by the JS reader.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.sentlog_projects(id,owner_id,status,client_key) VALUES
 ('78000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active','reconcile-client-1');
INSERT INTO public.sentlog_project_snapshots(project_id,owner_id,revision,payload)
 SELECT '78000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',10,
  pg_catalog.jsonb_set(pg_catalog.jsonb_set(p,'{project,drawings}',
    pg_catalog.jsonb_build_array(p#>'{drawings,0,meta}',p#>'{drawings,1,meta}',
      '{"id":"drawing:empty","name":"Empty drawing still retained"}'::jsonb)),
   '{drawings}',(p->'drawings')||'[{"meta":{"id":"drawing:empty","name":"Empty drawing still retained"},"state":{"shapes":[],"collabDeletedRecords":[],"scale":0.005}}]'::jsonb)
 FROM (SELECT public.baseline_test_payload('reconcile-client-1') AS p) fixture;
CREATE TEMP TABLE delta_reconcile_contract(value jsonb NOT NULL);
GRANT INSERT,SELECT ON delta_reconcile_contract TO authenticated;
SET LOCAL ROLE authenticated;
DO $test$
DECLARE receipt jsonb; records jsonb:='[]'::jsonb; metadata jsonb:='[]'::jsonb;
  page jsonb; after_ordinal bigint:=0; original jsonb;
  pid constant uuid:='78000000-0000-4000-8000-000000000001';
  did constant uuid:='aaaaaaaa-0000-4000-8000-000000000001';
BEGIN
 PERFORM pg_catalog.set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
 receipt:=public.sentlog_delta_prepare_baseline_v1(pid,did,10);
 receipt:=public.sentlog_delta_import_baseline_batch_v1(pid,did,(receipt->>'baselineId')::uuid,100);
 LOOP
  page:=public.sentlog_delta_read_baseline_page_v1(pid,did,(receipt->>'baselineId')::uuid,after_ordinal,1);
  records:=records||pg_catalog.jsonb_build_array(page);after_ordinal:=(page->>'nextOrdinal')::bigint;
  EXIT WHEN NOT (page->>'hasMore')::boolean;
 END LOOP;
 after_ordinal:=0;
 LOOP
  page:=public.sentlog_delta_read_baseline_metadata_page_v1(pid,did,(receipt->>'baselineId')::uuid,after_ordinal,1);
  metadata:=metadata||pg_catalog.jsonb_build_array(page);after_ordinal:=(page->>'nextOrdinal')::bigint;
  EXIT WHEN NOT (page->>'hasMore')::boolean;
 END LOOP;
 SELECT payload INTO original FROM public.sentlog_project_snapshots WHERE project_id=pid;
 INSERT INTO delta_reconcile_contract VALUES(pg_catalog.jsonb_build_object(
  'receipt',receipt,'recordPages',records,'metadataPages',metadata,'sourceSnapshot',original));
END $test$;
SELECT value AS contract FROM delta_reconcile_contract;
ROLLBACK;
