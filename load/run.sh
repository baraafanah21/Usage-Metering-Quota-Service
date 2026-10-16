#!/usr/bin/env bash
# One load scenario, end to end (DESIGN.md §11, docs/performance.md):
#   fresh setup → k6 → summary JSON → verify.sql → one-line summary.
#
#   load/run.sh <scenario> <label>
#   FRESH_STACK=1 load/run.sh <scenario> <label>   # first `docker compose down -v`: empty database
#
# Writes load/results/<label>/<scenario>.{json,k6.txt,metrics.json,pgss.txt,verify.txt}.
# Exits non-zero if k6 thresholds or verify.sql fail. Needs docker (compose v2), bash, curl.
set -euo pipefail

SCENARIOS="spread hot-account hot-user exhaust retry-storm plan-flip"
scenario=${1:-}
label=${2:-}
if [[ -z "$scenario" || -z "$label" || " $SCENARIOS " != *" $scenario "* || ! "$label" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]]; then
  echo "usage: load/run.sh <${SCENARIOS// /|}> <label>" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
# Files the containers write under ./load belong to the host user.
export LOAD_UID LOAD_GID
LOAD_UID=$(id -u)
LOAD_GID=$(id -g)
API_HOST_URL=${API_HOST_URL:-http://localhost:3000}
out="load/results/$label"
work="load/.work"
mkdir -p "$out" "$work"

compose() { docker compose --progress quiet "$@"; }
psql_db() { compose exec -T db psql -U metering -d metering -X -q -v ON_ERROR_STOP=1 "$@"; }
node_load() { compose --profile loadtest run --rm --no-deps -T --entrypoint node load-setup "$@"; }
# "<unix seconds> <db cpu µs> <api cpu µs>": CPU used by each container (cgroup v2) so far.
cpu_snapshot() {
  local db api
  db=$(compose exec -T db sh -c 'grep ^usage_usec /sys/fs/cgroup/cpu.stat')
  api=$(compose exec -T api sh -c 'grep ^usage_usec /sys/fs/cgroup/cpu.stat')
  echo "$(date +%s.%N) ${db#usage_usec } ${api#usage_usec }"
}

if [[ "${FRESH_STACK:-}" == 1 ]]; then
  echo "== fresh stack: docker compose down -v"
  compose --profile loadtest down -v --remove-orphans >/dev/null 2>&1
fi
echo "== stack: db + api"
compose up -d --build --wait --wait-timeout 180 db api >/dev/null 2>&1 || {
  compose logs --no-color --tail 50 db api >&2
  exit 1
}
psql_db -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements" >/dev/null

echo "== setup: $scenario"
compose --profile loadtest run --rm --no-deps -T load-setup "$scenario" ".work/$scenario.json"

# Statement stats and /metrics deltas cover the k6 run only, not setup.
psql_db -c "SELECT pg_stat_statements_reset()" >/dev/null
curl -fsS "$API_HOST_URL/metrics" >"$work/$scenario.before.prom"
cpu_snapshot >"$work/$scenario.cpu.txt"
(
  while true; do
    printf '%s ' "$(date +%s.%N)"
    curl -fsS "$API_HOST_URL/metrics" | awk '/^db_pool_(total|idle|waiting) / { printf "%s=%s ", $1, $2 }'
    echo
    sleep 0.5
  done
) >"$work/$scenario.pool.txt" 2>/dev/null &
sampler=$!
trap 'kill $sampler 2>/dev/null || true' EXIT

echo "== k6: $scenario"
set +e
compose --profile loadtest run --rm --no-deps -T -e SETUP_FILE="/load/.work/$scenario.json" k6 \
  run --quiet --no-color \
  --summary-trend-stats "avg,min,med,max,p(90),p(95),p(99)" \
  --summary-export "/load/results/$label/$scenario.json" \
  "scenarios/$scenario.js" 2>&1 | tee "$out/$scenario.k6.txt"
k6_status=${PIPESTATUS[0]}
set -e

cpu_snapshot >>"$work/$scenario.cpu.txt"
kill "$sampler" 2>/dev/null || true
trap - EXIT
curl -fsS "$API_HOST_URL/metrics" >"$work/$scenario.after.prom"

# Top statements by total time during the run (where the database spent it).
psql_db -P pager=off -c "
  SELECT calls, round(total_exec_time::numeric, 1) AS total_ms, round(mean_exec_time::numeric, 3) AS mean_ms,
         round(max_exec_time::numeric, 1) AS max_ms, rows, left(regexp_replace(query, '\s+', ' ', 'g'), 140) AS query
  FROM pg_stat_statements
  WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  ORDER BY total_exec_time DESC LIMIT 15" >"$out/$scenario.pgss.txt"

echo "== verify.sql"
verify_args=()
expect=$(node_load -e "
  const s = JSON.parse(require('fs').readFileSync('.work/$scenario.json', 'utf8'));
  if (s.expect) console.log([s.accounts[0].accountId, s.expect.acceptedUnits, s.expect.ledgerRows].join(' '));")
if [[ -n "$expect" ]]; then
  read -r account_id units rows <<<"$expect"
  verify_args=(-v "account_id=$account_id" -v "expect_accepted_units=$units" -v "expect_ledger_rows=$rows")
fi
verify_status=0
psql_db "${verify_args[@]}" -f - <load/verify.sql >"$out/$scenario.verify.txt" 2>&1 || verify_status=$?
cat "$out/$scenario.verify.txt"

node_load report.ts metrics "results/$label" "$scenario"
node_load report.ts line "results/$label" "$scenario"

if [[ $k6_status -ne 0 ]]; then echo "FAILED: k6 exited $k6_status (thresholds)" >&2; fi
if [[ $verify_status -ne 0 ]]; then echo "FAILED: verify.sql" >&2; fi
[[ $k6_status -eq 0 && $verify_status -eq 0 ]]
