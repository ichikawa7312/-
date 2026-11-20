#!/usr/bin/env bash
# Real independent PostgreSQL sessions. Disposable LOCAL CI database only.
# Run after delta_baseline_fixture.sql, candidate SQL and assertions.
set -euo pipefail
test "${PGDATABASE:-}" = "sentlog_delta_test" || { echo 'unsafe database target' >&2; exit 1; }
case "${PGHOST:-}" in localhost|127.0.0.1|::1|'') ;; *) echo 'nonlocal database target' >&2; exit 1;; esac
test_dir=$(mktemp -d)
pids=()
cleanup() {
  for test_pid in "${pids[@]}"; do kill "$test_pid" 2>/dev/null || true; done
  rm -rf "$test_dir"
}
trap cleanup EXIT
owner_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
device_id='aaaaaaaa-0000-4000-8000-000000000001'
wait_for_activity() {
  local test_app=$1 test_kind=$2
  for _ in $(seq 1 80); do
    if test "$(psql -X -qAt -v ON_ERROR_STOP=1 -c \
      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='$test_app'
        AND wait_event_type='$test_kind');")" = t; then return 0; fi
    sleep 0.05
  done
  cat "$test_dir"/*.log
  echo "controlled race not reached: $test_app $test_kind" >&2
  exit 1
}
prepare() {
  local project_id=$1
  psql -X -qAt -v ON_ERROR_STOP=1 <<SQL >"$test_dir/prepare-$project_id.log" 2>&1
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.sub','$owner_id',false);
DO \$test\$
DECLARE receipt jsonb;
BEGIN
 receipt:=public.sentlog_delta_prepare_baseline_v1('$project_id','$device_id',10);
 PERFORM public.sentlog_delta_import_baseline_batch_v1('$project_id','$device_id',(receipt->>'baselineId')::uuid,100);
END \$test\$;
SQL
}
finish_sessions() {
  local failed=false
  for test_pid in "${pids[@]}"; do wait "$test_pid" || failed=true; done
  pids=()
  if test "$failed" = true; then cat "$test_dir"/*.log; exit 1; fi
}

# An old writer owns the table's ROW EXCLUSIVE lock first. Activation must
# wait, then reject its now-outdated source; it must not discard the old save.
project_id='77000000-0000-4000-8000-000000000010'
prepare "$project_id"
baseline_id=$(psql -X -qAt -v ON_ERROR_STOP=1 -c \
  "SELECT id FROM sentlog_delta_private.baselines WHERE project_id='$project_id' AND snapshot_revision=10")
psql -X -qAt -v ON_ERROR_STOP=1 <<SQL >"$test_dir/old-first.log" 2>&1 &
SET application_name='baseline-old-first';
SET statement_timeout='15s';
BEGIN;
UPDATE public.sentlog_project_snapshots SET revision=11,
 payload=pg_catalog.jsonb_set(payload,'{project,name}','"saved before cutover"'::jsonb)
 WHERE project_id='$project_id';
SELECT pg_sleep(4);
COMMIT;
SQL
pids+=("$!")
wait_for_activity baseline-old-first Timeout
psql -X -qAt -v ON_ERROR_STOP=1 <<SQL >"$test_dir/activation-after-old.log" 2>&1 &
SET application_name='baseline-activation-after-old';
SET statement_timeout='15s';
SELECT pg_catalog.set_config('request.jwt.claim.sub','$owner_id',false);
DO \$test\$
BEGIN
 BEGIN
  PERFORM sentlog_delta_private.activate_prepared_baseline('$project_id','$device_id','$baseline_id');
  RAISE EXCEPTION 'stale activation unexpectedly succeeded';
 EXCEPTION WHEN serialization_failure THEN
  IF SQLERRM NOT LIKE 'DELTA_BASELINE_STALE%' THEN RAISE; END IF;
 END;
END \$test\$;
SQL
pids+=("$!")
wait_for_activity baseline-activation-after-old Lock
finish_sessions
psql -X -qAt -v ON_ERROR_STOP=1 <<SQL
DO \$test\$
BEGIN
 IF (SELECT enabled FROM sentlog_delta_private.heads WHERE project_id='$project_id') OR
    NOT (SELECT revision=11 AND payload#>>'{project,name}'='saved before cutover'
      FROM public.sentlog_project_snapshots WHERE project_id='$project_id') OR
    EXISTS(SELECT 1 FROM sentlog_delta_private.record_states WHERE project_id='$project_id') OR
    EXISTS(SELECT 1 FROM public.sentlog_delta_events WHERE project_id='$project_id') THEN
   RAISE EXCEPTION 'old-first race lost data or activated a stale baseline'; END IF;
END \$test\$;
SQL
echo 'PASS baseline race: earlier legacy save is preserved and stale activation is rejected'

# Activation owns the table gate first. The old writer must wait for commit,
# then execute the legacy guard and fail; the old snapshot remains unchanged.
project_id='77000000-0000-4000-8000-000000000011'
prepare "$project_id"
baseline_id=$(psql -X -qAt -v ON_ERROR_STOP=1 -c \
  "SELECT id FROM sentlog_delta_private.baselines WHERE project_id='$project_id' AND snapshot_revision=10")
psql -X -qAt -v ON_ERROR_STOP=1 <<SQL >"$test_dir/activation-first.log" 2>&1 &
SET application_name='baseline-activation-first';
SET statement_timeout='15s';
SELECT pg_catalog.set_config('request.jwt.claim.sub','$owner_id',false);
BEGIN;
SELECT sentlog_delta_private.activate_prepared_baseline('$project_id','$device_id','$baseline_id');
SELECT pg_sleep(4);
COMMIT;
SQL
pids+=("$!")
wait_for_activity baseline-activation-first Timeout
psql -X -qAt -v ON_ERROR_STOP=1 <<SQL >"$test_dir/old-after-activation.log" 2>&1 &
SET application_name='baseline-old-after-activation';
SET statement_timeout='15s';
DO \$test\$
BEGIN
 BEGIN
  UPDATE public.sentlog_project_snapshots SET revision=11,
   payload=pg_catalog.jsonb_set(payload,'{project,name}','"must not save"'::jsonb) WHERE project_id='$project_id';
  RAISE EXCEPTION 'legacy writer crossed the activation boundary';
 EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT LIKE 'DELTA_UPGRADE_REQUIRED%' THEN RAISE; END IF;
 END;
END \$test\$;
SQL
pids+=("$!")
wait_for_activity baseline-old-after-activation Lock
finish_sessions
psql -X -qAt -v ON_ERROR_STOP=1 <<SQL
DO \$test\$
BEGIN
 IF NOT (SELECT enabled AND last_seq=0 FROM sentlog_delta_private.heads WHERE project_id='$project_id') OR
    NOT (SELECT revision=10 AND payload#>>'{project,name}'='baseline fixture'
      FROM public.sentlog_project_snapshots WHERE project_id='$project_id') OR
    (SELECT count(*) FROM sentlog_delta_private.record_states WHERE project_id='$project_id')<>3 OR
    EXISTS(SELECT 1 FROM public.sentlog_delta_events WHERE project_id='$project_id') THEN
   RAISE EXCEPTION 'activation-first race altered source, omitted records or created fake events'; END IF;
END \$test\$;
SQL
echo 'PASS baseline race: later legacy save waits and is rejected after activation'

# Concurrent import/retry requests serialize on the project head. All eight
# calls may succeed, but the three source records must be verified exactly once.
project_id='77000000-0000-4000-8000-000000000012'
psql -X -qAt -v ON_ERROR_STOP=1 -c \
 "SET ROLE authenticated; SELECT pg_catalog.set_config('request.jwt.claim.sub','$owner_id',false);
  SELECT public.sentlog_delta_prepare_baseline_v1('$project_id','$device_id',10);" >"$test_dir/prepare-parallel.log"
baseline_id=$(psql -X -qAt -v ON_ERROR_STOP=1 -c \
  "SELECT id FROM sentlog_delta_private.baselines WHERE project_id='$project_id' AND snapshot_revision=10")
for i in $(seq 1 8); do
  psql -X -qAt -v ON_ERROR_STOP=1 -c \
   "SET statement_timeout='15s'; SET ROLE authenticated;
    SELECT pg_catalog.set_config('request.jwt.claim.sub','$owner_id',false);
    SELECT public.sentlog_delta_import_baseline_batch_v1('$project_id','$device_id','$baseline_id',1);" \
    >"$test_dir/batch-$i.log" 2>&1 &
  pids+=("$!")
done
finish_sessions
psql -X -qAt -v ON_ERROR_STOP=1 <<SQL
DO \$test\$
BEGIN
 IF NOT (SELECT state='verified' AND imported_count=3 AND record_count=3
    FROM sentlog_delta_private.baselines WHERE id='$baseline_id') OR
    (SELECT count(*) FROM sentlog_delta_private.baseline_records WHERE baseline_id='$baseline_id' AND verified)<>3 OR
    (SELECT enabled FROM sentlog_delta_private.heads WHERE project_id='$project_id') THEN
   RAISE EXCEPTION 'parallel imports lost progress, duplicated records or activated delta'; END IF;
END \$test\$;
SQL
echo 'PASS baseline race: eight concurrent batch requests retain exactly three verified records'
