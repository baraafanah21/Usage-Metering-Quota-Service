#!/usr/bin/env bash
# Every scenario, N times, each run on a fresh stack (empty database), then the medians.
#
#   load/run-all.sh <label> [runs=3]
#
# Results: load/results/<label>/run<i>/<scenario>.*, medians in load/results/<label>/summary.{md,json}.
# About 25 minutes for 3 runs (docs/performance.md). Keeps going after a failed run and
# exits non-zero at the end if any run failed.
set -uo pipefail

label=${1:-}
runs=${2:-3}
if [[ ! "$label" =~ ^[A-Za-z0-9._-]+$ || ! "$runs" =~ ^[1-9][0-9]*$ ]]; then
  echo "usage: load/run-all.sh <label> [runs=3]" >&2
  exit 2
fi
cd "$(dirname "$0")/.."
export LOAD_UID LOAD_GID
LOAD_UID=$(id -u)
LOAD_GID=$(id -g)

failed=()
for ((i = 1; i <= runs; i++)); do
  for scenario in spread hot-account hot-user exhaust retry-storm plan-flip; do
    echo "######## $scenario, run $i of $runs"
    FRESH_STACK=1 load/run.sh "$scenario" "$label/run$i" || failed+=("$scenario/run$i")
  done
done

echo "######## medians over $runs run(s)"
docker compose --progress quiet --profile loadtest run --rm --no-deps -T --entrypoint node load-setup report.ts median "results/$label"

if ((${#failed[@]})); then
  echo "FAILED runs: ${failed[*]}" >&2
  exit 1
fi
