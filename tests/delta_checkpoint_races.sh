#!/usr/bin/env bash
# Real separate PostgreSQL sessions; run after delta_archive_races.sh in CI.
set -euo pipefail
test "${PGDATABASE:-}" = sentlog_delta_test || { echo 'unsafe database target' >&2; exit 1; }
case "${PGHOST:-}" in localhost|127.0.0.1|::1) ;; *) echo 'nonlocal database target' >&2; exit 1;; esac
psql_cmd=(psql -X --host="$PGHOST" --dbname="$PGDATABASE" -v ON_ERROR_STOP=1)
checkpoint_race_dir=$(mktemp -d)
trap 'rm -rf "$checkpoint_race_dir"' EXIT
"${psql_cmd[@]}" -q <<'SQL'
ALTER TABLE public.sentlog_project_snapshots ADD COLUMN IF NOT EXISTS updated_by_device uuid;
ALTER TABLE public.sentlog_project_snapshots ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
SQL
for file in db/collaboration_v1.sql docs/sentlog-delta-projection-prototype.sql docs/sentlog-delta-metadata-prototype.sql docs/sentlog-delta-checkpoint-prototype.sql tests/delta_checkpoint_race_fixture.sql; do
  "${psql_cmd[@]}" -q -f "$file" >"$checkpoint_race_dir/setup.log" 2>&1 || { cat "$checkpoint_race_dir/setup.log"; exit 1; }
done
wait_state() {
 local app=$1 kind=$2
 for _ in $(seq 1 80); do
  if test "$("${psql_cmd[@]}" -qAt -c "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='$app' AND wait_event_type='$kind');")" = t; then return 0; fi
  sleep 0.05
 done
 cat "$checkpoint_race_dir"/*.log
 echo "controlled checkpoint race not reached: $app $kind" >&2
 exit 1
}
join_processes() {
 local failed=false
 for process in "$@"; do wait "$process" || failed=true; done
 if test "$failed" = true; then cat "$checkpoint_race_dir"/*.log; exit 1; fi
}

# Event commits first: the waiting publisher must observe the newer head and
# reject its old expectation without allocating a compatibility revision.
"${psql_cmd[@]}" -qAt <<'SQL' >"$checkpoint_race_dir/event-first.log" 2>&1 &
SET application_name='checkpoint-event-first';SET statement_timeout='15s';
BEGIN;SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
SELECT public.sentlog_delta_append_v1('66000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001',
 'event-first','drawing','event-first',public.delta_checkpoint_test_event('event-first','66000000-0000-4000-8000-000000000001'));
SELECT pg_sleep(4);COMMIT;
SQL
holder=$!
wait_state checkpoint-event-first Timeout
"${psql_cmd[@]}" -qAt <<'SQL' >"$checkpoint_race_dir/publisher-after-event.log" 2>&1 &
SET application_name='checkpoint-publisher-after-event';SET statement_timeout='15s';SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
DO $test$ BEGIN
 BEGIN
  PERFORM public.sentlog_delta_publish_checkpoint_v1('66000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001',0,'racing-old-head');
  RAISE EXCEPTION 'stale publisher succeeded';
 EXCEPTION WHEN SQLSTATE '40001' THEN IF position('DELTA_CHECKPOINT_STALE_HEAD' IN SQLERRM)=0 THEN RAISE; END IF; END;
END $test$;
SQL
waiter=$!
wait_state checkpoint-publisher-after-event Lock
join_processes "$holder" "$waiter"
echo 'PASS event-first checkpoint race: waiting publisher rejects stale head'

# Publisher commits first: the event waits on the project lock. Once accepted,
# its newer head immediately invalidates the just-created archive certificate.
"${psql_cmd[@]}" -qAt <<'SQL' >"$checkpoint_race_dir/publisher-first.log" 2>&1 &
SET application_name='checkpoint-publisher-first';SET statement_timeout='15s';
BEGIN;SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
SELECT public.sentlog_delta_publish_checkpoint_v1('66000000-0000-4000-8000-000000000002','aaaaaaaa-0000-4000-8000-000000000001',0,'publish-first');
SELECT pg_sleep(4);COMMIT;
SQL
holder=$!
wait_state checkpoint-publisher-first Timeout
"${psql_cmd[@]}" -qAt <<'SQL' >"$checkpoint_race_dir/event-after-publisher.log" 2>&1 &
SET application_name='checkpoint-event-after-publisher';SET statement_timeout='15s';SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
SELECT public.sentlog_delta_append_v1('66000000-0000-4000-8000-000000000002','aaaaaaaa-0000-4000-8000-000000000001',
 'publisher-first','drawing','publisher-first',public.delta_checkpoint_test_event('publisher-first','66000000-0000-4000-8000-000000000002'));
DO $test$ BEGIN
 BEGIN
  PERFORM public.sentlog_archive_v1('begin','66000000-0000-4000-8000-000000000002','aaaaaaaa-0000-4000-8000-000000000001','{"revision":2}'::jsonb);
  RAISE EXCEPTION 'archive accepted a superseded checkpoint';
 EXCEPTION WHEN SQLSTATE '55000' THEN IF position('DELTA_ARCHIVE_PROJECTION_REQUIRED' IN SQLERRM)=0 THEN RAISE; END IF; END;
END $test$;
SQL
waiter=$!
wait_state checkpoint-event-after-publisher Lock
join_processes "$holder" "$waiter"
echo 'PASS publisher-first race: later accepted event invalidates archive eligibility'

# Actual archive begin acquires the project lock and captures the certified
# snapshot. A waiting event must roll back its entire semantic/sequence write.
"${psql_cmd[@]}" -qAt <<'SQL' >"$checkpoint_race_dir/archive-first.log" 2>&1 &
SET application_name='checkpoint-archive-first';SET statement_timeout='15s';
BEGIN;SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
SELECT public.sentlog_archive_v1('begin','66000000-0000-4000-8000-000000000003','aaaaaaaa-0000-4000-8000-000000000001','{"revision":2}'::jsonb);
SELECT pg_sleep(4);COMMIT;
SQL
holder=$!
wait_state checkpoint-archive-first Timeout
"${psql_cmd[@]}" -qAt <<'SQL' >"$checkpoint_race_dir/event-after-archive.log" 2>&1 &
SET application_name='checkpoint-event-after-archive';SET statement_timeout='15s';SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
DO $test$ BEGIN
 BEGIN
  PERFORM public.sentlog_delta_append_v1('66000000-0000-4000-8000-000000000003','aaaaaaaa-0000-4000-8000-000000000001',
   'archive-frozen','drawing','archive-frozen',public.delta_checkpoint_test_event('archive-frozen','66000000-0000-4000-8000-000000000003'));
  RAISE EXCEPTION 'event crossed certified archive freeze';
 EXCEPTION WHEN SQLSTATE '55000' THEN IF position('DELTA_ARCHIVE_FROZEN' IN SQLERRM)=0 THEN RAISE; END IF; END;
END $test$;
SQL
waiter=$!
wait_state checkpoint-event-after-archive Lock
join_processes "$holder" "$waiter"
echo 'PASS certified archive-first race: waiting edit rolls back completely'

# A whole grouped operation wins the lock first; archive begin may not certify
# a prefix or the preceding snapshot after waiting for that group.
"${psql_cmd[@]}" -qAt <<'SQL' >"$checkpoint_race_dir/group-first.log" 2>&1 &
SET application_name='checkpoint-group-first';SET statement_timeout='15s';
BEGIN;SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
SELECT public.sentlog_delta_append_group_v1('66000000-0000-4000-8000-000000000004','aaaaaaaa-0000-4000-8000-000000000001',
 jsonb_build_object('schema',1,'kind','atomic-group','groupId','checkpoint-race-group',
 'projectId','66000000-0000-4000-8000-000000000004','deviceId','aaaaaaaa-0000-4000-8000-000000000001',
 'events',jsonb_build_array(public.delta_checkpoint_test_event('group-a','66000000-0000-4000-8000-000000000004'),
 public.delta_checkpoint_test_event('group-b','66000000-0000-4000-8000-000000000004'))));
SELECT pg_sleep(4);COMMIT;
SQL
holder=$!
wait_state checkpoint-group-first Timeout
"${psql_cmd[@]}" -qAt <<'SQL' >"$checkpoint_race_dir/archive-after-group.log" 2>&1 &
SET application_name='checkpoint-archive-after-group';SET statement_timeout='15s';SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
DO $test$ BEGIN
 BEGIN
  PERFORM public.sentlog_archive_v1('begin','66000000-0000-4000-8000-000000000004','aaaaaaaa-0000-4000-8000-000000000001','{"revision":2}'::jsonb);
  RAISE EXCEPTION 'archive accepted pre-group snapshot';
 EXCEPTION WHEN SQLSTATE '55000' THEN IF position('DELTA_ARCHIVE_PROJECTION_REQUIRED' IN SQLERRM)=0 THEN RAISE; END IF; END;
END $test$;
SQL
waiter=$!
wait_state checkpoint-archive-after-group Lock
join_processes "$holder" "$waiter"
echo 'PASS group-first race: waiting archive refuses a pre-group snapshot'

pids=()
for i in $(seq 1 8); do
 "${psql_cmd[@]}" -qAt <<'SQL' >"$checkpoint_race_dir/retry-$i.log" 2>&1 &
SET statement_timeout='15s';SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
SELECT public.sentlog_delta_publish_checkpoint_v1('66000000-0000-4000-8000-000000000005','aaaaaaaa-0000-4000-8000-000000000001',0,'simultaneous-retry');
SQL
 pids+=("$!")
done
join_processes "${pids[@]}"
# A valid append already proved that the deferred trigger can run at an
# authenticated outer COMMIT. It must still reject a missing drawing then,
# rolling back the event and sequence rather than granting private-table access.
if "${psql_cmd[@]}" -qAt <<'SQL' >"$checkpoint_race_dir/orphan-commit.log" 2>&1; then
BEGIN;SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
SELECT public.sentlog_delta_append_v1('66000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001',
 'orphan-at-commit','missing-drawing','orphan-at-commit',
 jsonb_set(public.delta_checkpoint_test_event('orphan-at-commit','66000000-0000-4000-8000-000000000001'),'{drawingId}','"missing-drawing"'));
COMMIT;
SQL
 echo 'orphan event passed authenticated outer COMMIT' >&2;exit 1
fi
case "$(cat "$checkpoint_race_dir/orphan-commit.log")" in
 *DELTA_METADATA_DRAWING_MISSING*) ;; *) cat "$checkpoint_race_dir/orphan-commit.log";exit 1;;
esac
"${psql_cmd[@]}" -q <<'SQL'
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
DO $test$
DECLARE job sentlog_archive_private.jobs%ROWTYPE;proof jsonb;result jsonb;
BEGIN
 IF pg_catalog.has_table_privilege('authenticated','sentlog_delta_private.record_states','SELECT') OR
    pg_catalog.has_function_privilege('authenticated','sentlog_delta_private.validate_metadata_membership()','EXECUTE') OR
    EXISTS(SELECT 1 FROM public.sentlog_delta_events WHERE event_id='orphan-at-commit') OR
    EXISTS(SELECT 1 FROM sentlog_delta_private.record_states WHERE record_id='orphan-at-commit') OR
    (SELECT last_seq FROM sentlog_delta_private.heads WHERE project_id='66000000-0000-4000-8000-000000000001')<>1 THEN
  RAISE EXCEPTION 'deferred membership validation leaked privileges or retained orphan writes'; END IF;
 IF (SELECT revision FROM public.sentlog_project_snapshots WHERE project_id='66000000-0000-4000-8000-000000000001')<>2 OR
    (SELECT count(*) FROM sentlog_delta_private.checkpoints WHERE project_id='66000000-0000-4000-8000-000000000001')<>1 THEN
  RAISE EXCEPTION 'stale publisher advanced snapshot'; END IF;
 IF EXISTS(SELECT 1 FROM public.sentlog_delta_events WHERE project_id='66000000-0000-4000-8000-000000000003') OR
    EXISTS(SELECT 1 FROM sentlog_delta_private.record_states WHERE project_id='66000000-0000-4000-8000-000000000003' AND drawing_id<>'@sentlog:metadata:v1') THEN
  RAISE EXCEPTION 'archive-frozen operation retained a partial write'; END IF;
 IF (SELECT last_seq FROM sentlog_delta_private.heads WHERE project_id='66000000-0000-4000-8000-000000000004')<>2 OR
    (SELECT count(*) FROM sentlog_delta_private.event_groups WHERE project_id='66000000-0000-4000-8000-000000000004')<>1 THEN
  RAISE EXCEPTION 'group was split or duplicated'; END IF;
 IF EXISTS(SELECT 1 FROM sentlog_archive_private.jobs WHERE project_id IN('66000000-0000-4000-8000-000000000002','66000000-0000-4000-8000-000000000004')) THEN
  RAISE EXCEPTION 'stale archive job survived'; END IF;
 IF (SELECT revision FROM public.sentlog_project_snapshots WHERE project_id='66000000-0000-4000-8000-000000000005')<>2 OR
    (SELECT count(*) FROM sentlog_delta_private.checkpoints WHERE project_id='66000000-0000-4000-8000-000000000005')<>1 OR
    (SELECT count(*) FROM sentlog_delta_private.checkpoint_requests WHERE project_id='66000000-0000-4000-8000-000000000005')<>1 OR
    EXISTS(SELECT 1 FROM sentlog_delta_private.checkpoint_write_authority) THEN
  RAISE EXCEPTION 'concurrent publisher retries duplicated a revision or left authority'; END IF;
 SELECT * INTO job FROM sentlog_archive_private.jobs WHERE project_id='66000000-0000-4000-8000-000000000003' AND state='checking';
 proof:=jsonb_build_object('schema',1,'headSeq',0,'cursor',0,'pending',0,'revision',job.revision,'payloadSha256',job.delta_checkpoint->>'payloadSha256');
 PERFORM public.sentlog_archive_v1('report',job.project_id,'aaaaaaaa-0000-4000-8000-000000000001',
  jsonb_build_object('job_id',job.id,'catalog_hash',job.catalog_hash,'clean',true,'delta_proof',proof));
 PERFORM public.sentlog_archive_v1('pc_complete',job.project_id,'aaaaaaaa-0000-4000-8000-000000000099',
  jsonb_build_object('job_id',job.id,'catalog_hash',job.catalog_hash,'file_count',1,'package_sha256',repeat('a',64),'path','synthetic/verified-pc'));
 result:=public.sentlog_archive_v1('finalize',job.project_id,'aaaaaaaa-0000-4000-8000-000000000001',jsonb_build_object('job_id',job.id));
 IF result->>'status'<>'archived' THEN RAISE EXCEPTION 'actual certified archive did not finalize'; END IF;
 result:=public.sentlog_archive_v1('reopen',job.project_id,'aaaaaaaa-0000-4000-8000-000000000001');
 IF result->>'status'<>'active' THEN RAISE EXCEPTION 'actual certified archive did not reopen'; END IF;
END $test$;
DROP FUNCTION public.delta_checkpoint_test_event(text,uuid);
SQL
echo 'PASS eight publisher retries: one certified revision, no leaked authority'
echo 'PASS authenticated outer COMMIT validates membership without private-table grants'
echo 'PASS actual PostgreSQL phone report, PC completion, finalize and reopen'
