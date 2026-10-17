#!/usr/bin/env bash
# Runs every curl example from README.md, in order, against a running stack, and fails if a
# status code or a key field differs from what the README shows.
#
#   docker compose up --build -d --wait
#   docs/api-examples.sh            # SHOW=1 also prints every response body
#
# Needs bash, curl and jq. API defaults to http://localhost:3000, ADMIN_API_KEY to the
# compose dev default. Each run creates new accounts, so it can run any number of times.
set -euo pipefail

API=${API:-http://localhost:3000}
ADMIN=${ADMIN_API_KEY:-dev-admin-key-change-me-0123456789abcdef}
BASIC=00000000-0000-4000-8000-00000000b001
PREMIUM=00000000-0000-4000-8000-00000000b002
PRO=00000000-0000-4000-8000-00000000a002

passed=0
BODY=""
STATUS=""

# ex "<title>" <expected status> [jq assertion...] -- <curl args>
# Runs curl, then checks the status and each jq assertion (which must evaluate to true).
ex() {
  local title=$1 want=$2
  shift 2
  local checks=()
  while [[ $1 != -- ]]; do checks+=("$1"); shift; done
  shift
  local out
  out=$(mktemp)
  STATUS=$(curl -sS -o "$out" -w '%{http_code}' "$@")
  BODY=$(cat "$out")
  rm -f "$out"
  if [[ ${SHOW:-} == 1 ]]; then printf '\n## %s → %s\n%s\n' "$title" "$STATUS" "$BODY"; fi
  if [[ $STATUS != "$want" ]]; then
    printf 'FAIL %s: status %s, expected %s\n%s\n' "$title" "$STATUS" "$want" "$BODY" >&2
    exit 1
  fi
  local c
  for c in "${checks[@]}"; do
    if ! jq -e "$c" >/dev/null 2>&1 <<<"$BODY"; then
      printf 'FAIL %s: %s is not true for\n%s\n' "$title" "$c" "$BODY" >&2
      exit 1
    fi
  done
  passed=$((passed + 1))
  printf 'ok   %-58s %s\n' "$title" "$STATUS"
}

json=(-H 'Content-Type: application/json')

# ---- Ops ------------------------------------------------------------------------------
ex "GET /health/live" 200 '.status == "ok"' -- "$API/health/live"
ex "GET /health/ready" 200 '.status == "ok"' -- "$API/health/ready"
STATUS=$(curl -sS -o /dev/null -w '%{http_code}' "$API/metrics")
[[ $STATUS == 200 ]] && curl -sS "$API/metrics" | grep -q '^consume_decisions_total\|^db_pool_total ' || {
  echo "FAIL GET /metrics: status $STATUS or no metrics" >&2
  exit 1
}
passed=$((passed + 1)); printf 'ok   %-58s %s\n' "GET /metrics" 200

# ---- Admin: create an account ---------------------------------------------------------
ex "POST /v1/admin/accounts" 201 \
  '.account.name == "DocuCorp"' '.account.plan.name == "Starter"' '.apiKey.key | test("^mk_[0-9A-Za-z]{43}$")' -- \
  -X POST "$API/v1/admin/accounts" -H "X-Admin-Key: $ADMIN" "${json[@]}" -d '{"name":"DocuCorp"}'
KEY=$(jq -r .apiKey.key <<<"$BODY")
key=(-H "X-API-Key: $KEY")

ex "admin call without the admin key" 401 '.code == "MISSING_ADMIN_KEY"' -- \
  -X POST "$API/v1/admin/accounts" "${json[@]}" -d '{"name":"x"}'

# ---- API keys: 401s -------------------------------------------------------------------
ex "no X-API-Key" 401 '.code == "MISSING_API_KEY"' '.status == 401' -- "$API/v1/account"
ex "wrong X-API-Key" 401 '.code == "INVALID_API_KEY"' -- "$API/v1/account" -H "X-API-Key: mk_not-a-real-key"

# ---- Account ----------------------------------------------------------------------------
ex "GET /v1/account" 200 \
  '.name == "DocuCorp"' '.plan.name == "Starter"' '.plan.rules == {"monthlyAllowance":10000,"maxUnitsPerRequest":100}' \
  '.currentMonth.used == 0' '.currentMonth.remaining == 10000' -- \
  "$API/v1/account" "${key[@]}"

ex "PUT /v1/account/plan (Pro)" 200 '.plan.name == "Pro"' -- \
  -X PUT "$API/v1/account/plan" "${key[@]}" "${json[@]}" -d "{\"planId\":\"$PRO\"}"

# ---- Plans ------------------------------------------------------------------------------
ex "GET /v1/plans?scope=user" 200 \
  '[.plans[].name] == ["Basic","Premium"]' 'all(.plans[]; .predefined)' -- \
  "$API/v1/plans?scope=user" "${key[@]}"

ex "POST /v1/plans (custom account plan)" 201 \
  '.name == "Team"' '.scope == "account"' '.predefined == false' '.version == 1' \
  '.rules == {"monthlyAllowance":60,"maxUnitsPerRequest":50}' -- \
  -X POST "$API/v1/plans" "${key[@]}" "${json[@]}" \
  -d '{"name":"Team","scope":"account","rules":{"monthlyAllowance":60,"maxUnitsPerRequest":50}}'
PLAN=$(jq -r .id <<<"$BODY")

ex "PUT /v1/account/plan (custom)" 200 '.plan.name == "Team"' -- \
  -X PUT "$API/v1/account/plan" "${key[@]}" "${json[@]}" -d "{\"planId\":\"$PLAN\"}"

ex "GET /v1/plans/:planId" 200 '.name == "Team"' '.assignments == {"accounts":1,"users":0}' -- \
  "$API/v1/plans/$PLAN" "${key[@]}"

ex "PATCH a predefined plan" 403 '.code == "PLAN_READ_ONLY"' -- \
  -X PATCH "$API/v1/plans/$BASIC" "${key[@]}" "${json[@]}" -d '{"rules":{"monthlyAllowance":5}}'

# ---- Users ------------------------------------------------------------------------------
ex "POST /v1/users alice (default Basic)" 201 '.externalId == "alice"' '.plan.name == "Basic"' -- \
  -X POST "$API/v1/users" "${key[@]}" "${json[@]}" -d '{"externalId":"alice"}'
ex "POST /v1/users bob (Premium)" 201 '.plan.name == "Premium"' -- \
  -X POST "$API/v1/users" "${key[@]}" "${json[@]}" -d "{\"externalId\":\"bob\",\"planId\":\"$PREMIUM\"}"
ex "POST /v1/users carol" 201 '.plan.name == "Basic"' -- \
  -X POST "$API/v1/users" "${key[@]}" "${json[@]}" -d '{"externalId":"carol"}'
ex "POST /v1/users alice again" 409 '.code == "USER_ALREADY_EXISTS"' -- \
  -X POST "$API/v1/users" "${key[@]}" "${json[@]}" -d '{"externalId":"alice"}'

ex "GET /v1/users" 200 '[.users[].externalId] == ["alice","bob","carol"]' '.nextCursor == null' -- \
  "$API/v1/users?limit=20" "${key[@]}"
ex "GET /v1/users?limit=2" 200 '(.users | length) == 2' '.nextCursor != null' -- \
  "$API/v1/users?limit=2" "${key[@]}"
CURSOR=$(jq -r .nextCursor <<<"$BODY")
ex "GET /v1/users?cursor=…" 200 '[.users[].externalId] == ["carol"]' '.nextCursor == null' -- \
  "$API/v1/users?limit=2&cursor=$CURSOR" "${key[@]}"

ex "GET /v1/users/:externalId" 200 '.externalId == "bob"' '.plan.name == "Premium"' -- \
  "$API/v1/users/bob" "${key[@]}"

ex "GET /v1/users/:externalId/limits" 200 \
  '.account.planName == "Team"' '.account.monthlyAllowance == 60' '.account.remaining == 60' \
  '.user.planName == "Basic"' '.user.maxUnitsPerRequest == 20' '.user.remaining == 1000' -- \
  "$API/v1/users/alice/limits" "${key[@]}"

# ---- Consume: the brief's three examples, then retries ----------------------------------
ex "consume: alice 25 (Basic max 20)" 200 \
  '.decision == "rejected"' '.reason.scope == "user"' '.reason.rule == "max_units_per_request"' \
  '.reason.limit == 20' '.reason.actual == 25' '.user.used == 0' -- \
  -X POST "$API/v1/consume" "${key[@]}" "${json[@]}" -d '{"userId":"alice","units":25,"requestId":"doc-1"}'

ex "consume: alice 10" 200 \
  '.decision == "accepted"' '.violations == []' '.account.used == 10' '.account.remaining == 50' \
  '.user.used == 10' '.user.remaining == 990' '.replayed == false' -- \
  -X POST "$API/v1/consume" "${key[@]}" "${json[@]}" -d '{"userId":"alice","units":10,"requestId":"doc-2"}'

ex "consume: bob 45" 200 '.decision == "accepted"' '.account.remaining == 5' -- \
  -X POST "$API/v1/consume" "${key[@]}" "${json[@]}" -d '{"userId":"bob","units":45,"requestId":"doc-3"}'

ex "consume: carol 10 (account has 5 left)" 200 \
  '.decision == "rejected"' '.reason.scope == "account"' '.reason.rule == "monthly_allowance"' \
  '.reason.limit == 60' '.account.remaining == 5' '.user.remaining == 1000' -- \
  -X POST "$API/v1/consume" "${key[@]}" "${json[@]}" -d '{"userId":"carol","units":10,"requestId":"doc-4"}'

ex "consume: retry doc-2 (replay)" 200 \
  '.decision == "accepted"' '.replayed == true' '.account.used == 10' -- \
  -X POST "$API/v1/consume" "${key[@]}" "${json[@]}" -d '{"userId":"alice","units":10,"requestId":"doc-2"}'
curl -sS -o /dev/null -D - -X POST "$API/v1/consume" "${key[@]}" "${json[@]}" \
  -d '{"userId":"alice","units":10,"requestId":"doc-2"}' | grep -qi '^idempotent-replayed: true' || {
  echo "FAIL replay: no Idempotent-Replayed header" >&2
  exit 1
}
passed=$((passed + 1)); printf 'ok   %-58s %s\n' "replay sets Idempotent-Replayed: true" 200

ex "consume: doc-2 with other units" 409 '.code == "IDEMPOTENCY_CONFLICT"' -- \
  -X POST "$API/v1/consume" "${key[@]}" "${json[@]}" -d '{"userId":"alice","units":11,"requestId":"doc-2"}'

ex "consume: unknown user" 404 '.code == "USER_NOT_FOUND"' -- \
  -X POST "$API/v1/consume" "${key[@]}" "${json[@]}" -d '{"userId":"zoe","units":1,"requestId":"doc-5"}'

ex "consume: units 0" 400 '.code == "VALIDATION_ERROR"' '.errors[0].path == "body.units"' -- \
  -X POST "$API/v1/consume" "${key[@]}" "${json[@]}" -d '{"userId":"alice","units":0,"requestId":"doc-5"}'

# ---- Plan changes -----------------------------------------------------------------------
ex "PATCH /v1/plans/:planId (monthly 200)" 200 \
  '.version == 2' '.rules == {"monthlyAllowance":200,"maxUnitsPerRequest":50}' -- \
  -X PATCH "$API/v1/plans/$PLAN" "${key[@]}" "${json[@]}" -d '{"rules":{"monthlyAllowance":200}}'

ex "PUT /v1/users/:externalId/plan (alice → Premium)" 200 '.plan.name == "Premium"' -- \
  -X PUT "$API/v1/users/alice/plan" "${key[@]}" "${json[@]}" -d "{\"planId\":\"$PREMIUM\"}"

ex "consume: carol 10 after the change" 200 '.decision == "accepted"' '.account.remaining == 135' -- \
  -X POST "$API/v1/consume" "${key[@]}" "${json[@]}" -d '{"userId":"carol","units":10,"requestId":"doc-6"}'

ex "consume: alice 25 on Premium (usage kept)" 200 '.decision == "accepted"' '.user.used == 35' -- \
  -X POST "$API/v1/consume" "${key[@]}" "${json[@]}" -d '{"userId":"alice","units":25,"requestId":"doc-7"}'

ex "PATCH: remove the per-request rule (null)" 200 \
  '.version == 3' '.rules == {"monthlyAllowance":200,"maxUnitsPerRequest":null}' -- \
  -X PATCH "$API/v1/plans/$PLAN" "${key[@]}" "${json[@]}" -d '{"rules":{"maxUnitsPerRequest":null}}'

ex "PATCH: lower the allowance below usage" 200 '.rules.monthlyAllowance == 50' -- \
  -X PATCH "$API/v1/plans/$PLAN" "${key[@]}" "${json[@]}" -d '{"rules":{"monthlyAllowance":50}}'

ex "limits after lowering: remaining 0, not negative" 200 '.account.used == 90' '.account.remaining == 0' -- \
  "$API/v1/users/carol/limits" "${key[@]}"

# ---- Usage and history ------------------------------------------------------------------
ex "GET /v1/usage" 200 \
  '.account.used == 90' '[.users[] | {userId, used}] == [{"userId":"alice","used":35},{"userId":"bob","used":45},{"userId":"carol","used":10}]' -- \
  "$API/v1/usage" "${key[@]}"
MONTH=$(jq -r .month <<<"$BODY")

ex "GET /v1/users/:externalId/usage" 200 '.userId == "alice"' '.used == 35' '.month == "'"$MONTH"'"' -- \
  "$API/v1/users/alice/usage?month=$MONTH" "${key[@]}"

ex "GET /v1/usage for a month without data" 200 '.month == "2020-01"' '.account.used == 0' -- \
  "$API/v1/usage?month=2020-01" "${key[@]}"

ex "GET /v1/usage?month=2026-13" 400 '.code == "VALIDATION_ERROR"' -- \
  "$API/v1/usage?month=2026-13" "${key[@]}"

ex "GET /v1/requests?userId=alice" 200 \
  '[.requests[].requestId] == ["doc-7","doc-2","doc-1"]' \
  '.requests[2].reason == {"scope":"user","rule":"max_units_per_request"}' '.requests[1].reason == null' -- \
  "$API/v1/requests?userId=alice" "${key[@]}"

ex "GET /v1/requests?decision=rejected&include=evaluation" 200 \
  '[.requests[].requestId] == ["doc-4","doc-1"]' '.requests[0].evaluation.reason.rule == "monthly_allowance"' -- \
  "$API/v1/requests?decision=rejected&include=evaluation" "${key[@]}"

# ---- Isolation: another account sees nothing of DocuCorp's ------------------------------
ex "POST /v1/admin/accounts (second account)" 201 '.account.name == "OtherCorp"' -- \
  -X POST "$API/v1/admin/accounts" -H "X-Admin-Key: $ADMIN" "${json[@]}" -d '{"name":"OtherCorp"}'
OTHER=$(jq -r .apiKey.key <<<"$BODY")

ex "other account: DocuCorp's user" 404 '.code == "USER_NOT_FOUND"' -- \
  "$API/v1/users/alice" -H "X-API-Key: $OTHER"
ex "other account: DocuCorp's plan" 404 '.code == "PLAN_NOT_FOUND"' -- \
  "$API/v1/plans/$PLAN" -H "X-API-Key: $OTHER"

echo "all $passed examples passed"
