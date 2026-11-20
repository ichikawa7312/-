-- Reproduce a pre-fix archive check against an already enabled delta head.
-- Installing the compatibility guard must preserve this job but stop new writes.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
DO $setup$
DECLARE j jsonb;
BEGIN
  j:=public.sentlog_archive_v1('begin','44444444-1111-4111-8111-111111111111',
    'aaaaaaaa-0000-4000-8000-000000000001','{"revision":1}'::jsonb);
  PERFORM public.sentlog_archive_v1('report','44444444-1111-4111-8111-111111111111',
    'aaaaaaaa-0000-4000-8000-000000000001',jsonb_build_object('job_id',j->>'id','catalog_hash',j->>'catalog_hash','clean',true));
  PERFORM public.sentlog_archive_v1('pc_complete','44444444-1111-4111-8111-111111111111',
    'aaaaaaaa-0000-4000-8000-000000000099',jsonb_build_object('job_id',j->>'id','catalog_hash',j->>'catalog_hash',
    'file_count',0,'package_sha256',repeat('c',64),'path','synthetic-before-guard'));
END $setup$;
COMMIT;
