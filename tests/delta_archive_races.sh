#!/usr/bin/env bash
# Real separate PostgreSQL sessions after delta_archive_assertions.sql.
# Only the disposable loopback CI database is allowed; PGlite is not a race test.
set -euo pipefail
test "${PGDATABASE:-}" = sentlog_delta_test || { echo 'unsafe database target' >&2; exit 1; }
case "${PGHOST:-}" in localhost|127.0.0.1|::1) ;; *) echo 'nonlocal database target' >&2; exit 1;; esac
psql_cmd=(psql -X --host="$PGHOST" --dbname="$PGDATABASE" -v ON_ERROR_STOP=1)
delta_race_dir=$(mktemp -d)
trap 'rm -rf "$delta_race_dir"' EXIT
"${psql_cmd[@]}" -q <<'SQL'
CREATE FUNCTION public.delta_archive_test_group(label text,pid uuid) RETURNS jsonb LANGUAGE sql AS $fn$
 SELECT jsonb_build_object('schema',1,'kind','atomic-group','groupId',label,'projectId',pid,
 'deviceId','aaaaaaaa-0000-4000-8000-000000000001','events',
 (SELECT jsonb_agg(jsonb_build_object('schema',1,'eventId',label||'-'||n,'projectId',pid,
 'deviceId','aaaaaaaa-0000-4000-8000-000000000001','drawingId','drawing','recordId',label||'-'||n,'kind','create',
 'record',jsonb_build_object('id',label||'-'||n,'collab',jsonb_build_object('version',1,'comments','{}'::jsonb,
 'fields','{}'::jsonb,'photos','{}'::jsonb,'deletion',jsonb_build_object('revisions',jsonb_build_array(
 jsonb_build_object('id','alive-'||label||'-'||n,'parents','[]'::jsonb,
 'actor',jsonb_build_object('deviceId','aaaaaaaa-0000-4000-8000-000000000001','deviceName','synthetic'),
 'at',1,'deleted',false,'observed','[]'::jsonb)))))) ORDER BY n) FROM generate_series(1,2) n))
$fn$;
SQL
wait_state() {
  local app=$1 kind=$2 event=${3:-}
  for _ in $(seq 1 60); do
    if test "$("${psql_cmd[@]}" -qAt -c \
      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='$app'
       AND wait_event_type='$kind' AND ('$event'='' OR wait_event='$event'));")" = t; then return 0; fi
    sleep 0.05
  done
  return 1
}
join_processes() {
  local failed=false
  for pid in "$@"; do wait "$pid" || failed=true; done
  if test "$failed" = true; then cat "$delta_race_dir"/*.log; exit 1; fi
}

# Archive lock first: the group waits and then sees the existing checking job.
"${psql_cmd[@]}" -qAt <<'SQL' >"$delta_race_dir/frozen-holder.log" 2>&1 &
SET application_name='delta-archive-frozen-holder'; SET statement_timeout='12s';
BEGIN;
SELECT id FROM public.sentlog_projects WHERE id='44444444-1111-4111-8111-111111111111' FOR UPDATE;
SELECT pg_sleep(4);
COMMIT;
SQL
holder=$!
wait_state delta-archive-frozen-holder Timeout PgSleep
"${psql_cmd[@]}" -qAt <<'SQL' >"$delta_race_dir/frozen-group.log" 2>&1 &
SET application_name='delta-archive-frozen-group'; SET statement_timeout='12s';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
DO $test$
BEGIN
 BEGIN
  PERFORM public.sentlog_delta_append_group_v1('44444444-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',
    public.delta_archive_test_group('race-frozen','44444444-1111-4111-8111-111111111111'));
  RAISE EXCEPTION 'group crossed archive freeze';
 EXCEPTION WHEN SQLSTATE '55000' THEN
  IF position('DELTA_ARCHIVE_FROZEN' IN SQLERRM)=0 THEN RAISE; END IF;
 END;
END $test$;
SQL
appender=$!
wait_state delta-archive-frozen-group Lock
join_processes "$holder" "$appender"
echo 'PASS archive-first race: group waits and rejects the entire frozen write'

# Group first: real archive begin waits, then refuses a snapshot-only certificate.
"${psql_cmd[@]}" -qAt <<'SQL' >"$delta_race_dir/group-holder.log" 2>&1 &
SET application_name='delta-archive-group-holder'; SET statement_timeout='12s';
BEGIN; SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
SELECT public.sentlog_delta_append_group_v1('44444444-3333-4333-8333-333333333333','aaaaaaaa-0000-4000-8000-000000000001',
 public.delta_archive_test_group('race-complete','44444444-3333-4333-8333-333333333333'));
SELECT pg_sleep(4);
COMMIT;
SQL
holder=$!
wait_state delta-archive-group-holder Timeout PgSleep
"${psql_cmd[@]}" -qAt <<'SQL' >"$delta_race_dir/archive-waiter.log" 2>&1 &
SET application_name='delta-archive-archive-waiter'; SET statement_timeout='12s';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
DO $test$
BEGIN
 BEGIN
  PERFORM public.sentlog_archive_v1('begin','44444444-3333-4333-8333-333333333333',
   'aaaaaaaa-0000-4000-8000-000000000001','{"revision":1}'::jsonb);
  RAISE EXCEPTION 'stale snapshot archive was authorized';
 EXCEPTION WHEN SQLSTATE '55000' THEN
  IF position('DELTA_ARCHIVE_PROJECTION_REQUIRED' IN SQLERRM)=0 THEN RAISE; END IF;
 END;
END $test$;
SQL
archiver=$!
wait_state delta-archive-archive-waiter Lock
join_processes "$holder" "$archiver"
echo 'PASS group-first race: archive waits and refuses a stale snapshot certificate'

# Eight concurrent retries of the committed group must not allocate another range.
pids=()
for i in $(seq 1 8); do
  "${psql_cmd[@]}" -qAt <<'SQL' >"$delta_race_dir/retry-$i.log" 2>&1 &
SET statement_timeout='12s'; SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
SELECT public.sentlog_delta_append_group_v1('44444444-3333-4333-8333-333333333333','aaaaaaaa-0000-4000-8000-000000000001',
 public.delta_archive_test_group('race-complete','44444444-3333-4333-8333-333333333333'));
SQL
  pids+=("$!")
done
join_processes "${pids[@]}"
"${psql_cmd[@]}" <<'SQL'
DO $test$
BEGIN
 IF EXISTS(SELECT 1 FROM public.sentlog_delta_events WHERE project_id='44444444-1111-4111-8111-111111111111') OR
    EXISTS(SELECT 1 FROM sentlog_delta_private.record_states WHERE project_id='44444444-1111-4111-8111-111111111111') THEN
   RAISE EXCEPTION 'frozen race retained a partial write'; END IF;
 IF (SELECT last_seq FROM sentlog_delta_private.heads WHERE project_id='44444444-3333-4333-8333-333333333333')<>2 OR
    (SELECT count(*) FROM public.sentlog_delta_events WHERE project_id='44444444-3333-4333-8333-333333333333')<>2 OR
    (SELECT count(*) FROM sentlog_delta_private.event_groups WHERE project_id='44444444-3333-4333-8333-333333333333')<>1 THEN
   RAISE EXCEPTION 'committed group was split or duplicated'; END IF;
 IF EXISTS(SELECT 1 FROM sentlog_archive_private.jobs WHERE project_id='44444444-3333-4333-8333-333333333333') THEN
   RAISE EXCEPTION 'a stale snapshot archive job survived'; END IF;
END $test$;
DROP FUNCTION public.delta_archive_test_group(text,uuid);
SELECT 'PASS concurrent group retries: one complete group, no extra event or archive job' AS result;
SQL
