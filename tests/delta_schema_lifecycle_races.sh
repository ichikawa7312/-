#!/usr/bin/env bash
# Real PostgreSQL only: separate sessions exercise row locks. This is not a
# PGlite concurrency simulation and accepts only the disposable local CI DB.
set -euo pipefail
test "${PGDATABASE:-}" = "sentlog_delta_test" || { echo 'unsafe database target' >&2; exit 1; }
case "${PGHOST:-}" in localhost|127.0.0.1|::1|'') ;; *) echo 'nonlocal database target' >&2; exit 1;; esac
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
wait_for_state() {
  local application=$1 event_type=$2 event=$3
  for _ in $(seq 1 40); do
    if test "$(psql -X -qAt -v ON_ERROR_STOP=1 -c \
      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='$application'
        AND wait_event_type='$event_type' AND wait_event='$event');")" = t; then return 0; fi
    sleep 0.05
  done
  return 1
}
exercise() {
  local kind=$1 mutation=$2 restore=$3
  psql -X -qAt -v ON_ERROR_STOP=1 -c \
    "SET application_name='delta-hold-$kind'; SET statement_timeout='12s';
     BEGIN; $mutation; SELECT pg_sleep(5); COMMIT;" >"$dir/hold-$kind.log" 2>&1 &
  local holder=$!
  if ! wait_for_state "delta-hold-$kind" Timeout PgSleep; then
    wait "$holder" || true; cat "$dir"/*.log; echo 'holder did not enter the controlled race' >&2; exit 1
  fi
  psql -X -qAt -v ON_ERROR_STOP=1 <<SQL >"$dir/append-$kind.log" 2>&1 &
SET application_name='delta-append-$kind';
SET statement_timeout='12s';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
DO \$test\$
BEGIN
  BEGIN
    PERFORM public.sentlog_delta_append_v1(
      '11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001',
      'race-$kind','drawing-1','survey-1',public.test_event('race-$kind'));
    RAISE EXCEPTION 'append crossed a concurrent $kind boundary';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END \$test\$;
SQL
  local appender=$! blocked=false
  # A FOR SHARE read must wait for the competing status update's transaction.
  # It then rechecks the updated status and refuses the append.
  for _ in $(seq 1 40); do
    if test "$(psql -X -qAt -v ON_ERROR_STOP=1 -c \
      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='delta-append-$kind'
        AND wait_event_type='Lock');")" = t; then blocked=true; break; fi
    sleep 0.05
  done
  local failed=false
  wait "$holder" || failed=true
  wait "$appender" || failed=true
  psql -X -qAt -v ON_ERROR_STOP=1 -c "$restore"
  if test "$blocked" != true || test "$failed" = true; then
    cat "$dir"/*.log; echo "race assertion failed: $kind blocked=$blocked" >&2; exit 1
  fi
  psql -X -qAt -v ON_ERROR_STOP=1 -c \
    "DO \$test\$ BEGIN
      IF EXISTS(SELECT 1 FROM public.sentlog_delta_events WHERE event_id='race-$kind') THEN
        RAISE EXCEPTION 'refused lifecycle event was persisted';
      END IF;
    END \$test\$;"
  echo "PASS concurrent $kind: append waits, rechecks access, and leaves no event"
}
exercise project-archive \
  "UPDATE public.sentlog_projects SET status='archived' WHERE id='11111111-1111-4111-8111-111111111111'" \
  "UPDATE public.sentlog_projects SET status='active' WHERE id='11111111-1111-4111-8111-111111111111'"
exercise device-revocation \
  "UPDATE public.sentlog_devices SET active=false WHERE id='aaaaaaaa-0000-4000-8000-000000000001'" \
  "UPDATE public.sentlog_devices SET active=true WHERE id='aaaaaaaa-0000-4000-8000-000000000001'"
