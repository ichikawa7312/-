#!/usr/bin/env bash
# Disposable GitHub Actions PostgreSQL instance only. Never target a live DB.
set -euo pipefail
test "${PGDATABASE:-}" = "sentlog_delta_test" || { echo 'unsafe database target' >&2; exit 1; }
dir=$(mktemp -d); trap 'rm -rf "$dir"' EXIT
owner="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
project="11111111-1111-4111-8111-111111111111"
device="aaaaaaaa-0000-4000-8000-000000000001"
submit() {
  local id=$1
  psql -X -v ON_ERROR_STOP=1 -qAt -c \
    "SET ROLE authenticated;
     SELECT pg_catalog.set_config('request.jwt.claim.sub','$owner',false);
     SELECT public.sentlog_delta_append_v1(
      '$project','$device','$id','drawing-1','survey-1',
      public.test_event('$id','verified-$id'));" >"$dir/$id.log" 2>&1
}
pids=()
for i in $(seq 1 24); do submit "parallel-$i" & pids+=("$!"); done
for pid in "${pids[@]}"; do if ! wait "$pid"; then cat "$dir"/*.log; exit 1; fi; done
pids=()
for i in $(seq 1 8); do submit "parallel-dup" & pids+=("$!"); done
for pid in "${pids[@]}"; do if ! wait "$pid"; then cat "$dir"/*.log; exit 1; fi; done
psql -X -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE n bigint; maximum bigint; head bigint; uniques bigint;
BEGIN
 SELECT count(*),max(seq),count(DISTINCT seq) INTO n,maximum,uniques
 FROM public.sentlog_delta_events
 WHERE project_id='11111111-1111-4111-8111-111111111111';
 SELECT last_seq INTO head FROM sentlog_delta_private.heads
 WHERE project_id='11111111-1111-4111-8111-111111111111';
 IF n<>27 OR maximum<>27 OR head<>27 OR uniques<>27 THEN
   RAISE EXCEPTION 'parallel messages lost, duplicated or reordered: count % max % head % distinct %',
     n,maximum,head,uniques;
 END IF;
 IF (SELECT count(*) FROM public.sentlog_delta_events WHERE event_id='parallel-dup')<>1 THEN
   RAISE EXCEPTION 'parallel duplicate event was stored more than once';
 END IF;
 IF (SELECT count(*) FROM realtime.test_messages)<>27 THEN
   RAISE EXCEPTION 'duplicate broadcasts were emitted';
 END IF;
END $$;
SELECT 'PASS 24 concurrent writes + 8 concurrent duplicate retries: dense and durable event ordering' AS result;
SQL
