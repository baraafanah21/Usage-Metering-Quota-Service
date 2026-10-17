# Usage Metering & Quota Service

An HTTP service that a client application calls before it processes a unit of work (for example a document). The service decides whether the account and the user still have quota for the request. Each account and each user has a plan with a monthly allowance and a per-request limit. A request is accepted only if both levels allow it. Every decision, accepted or rejected, is recorded in a ledger. The service is built with TypeScript, Express 5 and PostgreSQL 16. The database enforces correctness when many requests arrive at once. [DESIGN.md](DESIGN.md) has the full design.

![The demo's guided scenario: alice is rejected by her user limit, carol by the shared account limit, then a configuration change lets both through](docs/media/scenario.gif)

The demo's guided scenario (see [Demo app](#demo-app)). A one-minute video that also shows a retry and the request history: [docs/media/demo.mp4](docs/media/demo.mp4). The captions and cursor were added at recording time; they aren't part of the app.

## Review in 10 minutes

```sh
docker compose up --build -d --wait                       # db, api (:3000) and the demo (:8080)
open http://localhost:8080                                # click "Run guided scenario" (Linux: xdg-open)
docs/api-examples.sh                                      # every curl example in this README, checked (needs curl, jq)
docker compose --profile test up -d --wait db-test        # test database on :5433
(cd api && npm ci && npm test)                            # unit, integration and concurrency tests (Node 22+)
```

Where to look first:

1. **The demo's guided scenario** (http://localhost:8080): the brief's story in six steps, with the raw API calls.
2. **[`api/src/services/consume.ts`](api/src/services/consume.ts)**: the consume decision, under 300 lines, with the locking and idempotency logic.
3. **[docs/performance.md](docs/performance.md)**: load-test method, numbers, and what was changed and why.
4. **[DESIGN.md](DESIGN.md)**: schema, locking argument (§6.3), error codes (§8.1).

## Quick start

**Prerequisites.** Docker with Compose v2 (`docker compose`, with profiles and `up --wait`). Tested with Docker Engine 29.6.1 and Compose 5.2.0. Node 22 or newer is needed only to run the tests, the demo smoke test or the API outside Docker. `docs/api-examples.sh` also needs `curl` and `jq`.

```sh
docker compose up --build
curl localhost:3000/health/ready   # {"status":"ok"}
```

| Service | Port | What it is |
| --- | --- | --- |
| `api` | 3000 | The metering API |
| `demo` | 8080 | The example client app (a web page and its own server) |
| `db` | none | PostgreSQL 16. Not published on the host: `docker compose exec db psql -U metering` |
| `db-test` | 5433 | A separate database for the tests (profile `test`, started only on request) |

On startup the API applies migrations and creates the predefined plans. Both are safe to repeat.

**Settings.** Everything has a working default, so no `.env` is needed to try it. For anything beyond a local trial, copy [.env.example](.env.example) to `.env` and set `ADMIN_API_KEY`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMIN_API_KEY` | `dev-admin-key-change-me-0123456789abcdef` (compose only) | The operator key for creating accounts. At least 32 characters; the API refuses to start without it. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `DB_POOL_MAX` | `20` | Database connections per API process (1–100). 20 was chosen by measurement, see [Performance](#performance). |
| `PORT`, `DATABASE_URL` | set by compose | Only needed when running the API outside Docker (`cd api && npm run dev`). |

**Reset.** `docker compose down -v` deletes the database and the demo's data. The next `docker compose up --build` starts from empty.

## Concepts

- **Account**: a customer of the service (a tenant). It has API keys, users, its own custom plans, and one account plan.
- **User**: a user of that customer's product, registered by the account. It is identified by the account's own id for it (`externalId`, for example `alice`) and has one user plan.
- **Plan**: a named set of rules with a **scope**: `account` (assigned to accounts) or `user` (assigned to users). Plans are either **predefined** (the same for everyone, read-only) or **custom** (created by one account, visible only to it).
- **Rules**: `monthlyAllowance` (units per calendar month) and `maxUnitsPerRequest` (units in one request). A plan may leave a rule out; then there is no limit of that kind at that level. A limit of `0` blocks all consumption.
- **Units**: what the client counts (pages, documents, tokens). Each request asks for a whole number of units from 1 to 1,000,000,000.
- **Month**: the UTC calendar month, by the database clock. Usage starts at 0 each month.

Both levels are checked separately against their own counters, and both must pass. A user's allowance never adds to the account's: all users of an account draw from the account's one monthly allowance.

**The brief's example.** The account is on Starter (10,000 per month, at most 100 per request) and the user on Basic (1,000 per month, at most 20 per request):

| Request | Result | Why |
| --- | --- | --- |
| 25 units | rejected, scope `user`, rule `max_units_per_request` | Basic allows at most 20 per request |
| 10 units | accepted | Within every limit at both levels |
| 10 units when the account has 5 left this month | rejected, scope `account`, rule `monthly_allowance` | The account's shared allowance binds, even though the user has plenty left |

These three cases are integration tests, and [Consume](#consume) below shows them as real API calls.

## API keys

**The operator creates an account** with the admin key. The response contains the account's first API key. **It is shown only in this response.** The service stores only its SHA-256 hash.

```sh
ADMIN=dev-admin-key-change-me-0123456789abcdef   # compose's default, or your ADMIN_API_KEY

curl -s -X POST localhost:3000/v1/admin/accounts \
  -H "X-Admin-Key: $ADMIN" -H 'Content-Type: application/json' -d '{"name":"DocuCorp"}'
```

```jsonc
// 201
{
  "account": {
    "id": "9b70fd1f-…", "name": "DocuCorp", "createdAt": "2026-10-17T09:07:24.943Z",
    "plan": { "id": "00000000-0000-4000-8000-00000000a001", "name": "Starter", "scope": "account", "predefined": true,
              "version": 1, "rules": { "monthlyAllowance": 10000, "maxUnitsPerRequest": 100 }, … },
    "currentMonth": { "month": "2026-10", "used": 0, "remaining": 10000 }
  },
  "apiKey": { "id": "c51e13f4-…", "key": "mk_5GL3gWqBtC0ZFExuENCgdJWWoSFlrrbvhHVrZ7zFM3U", "prefix": "mk_5GL3", "createdAt": "…" }
}
```

**Use the key** in the `X-API-Key` header on every `/v1` call. The examples below assume:

```sh
KEY=mk_5GL3gWqBtC0ZFExuENCgdJWWoSFlrrbvhHVrZ7zFM3U   # the apiKey.key from your response
```

A new account is on Starter unless the request names another predefined account plan (`{"name": "...", "planId": "..."}`). An account can switch to its own custom plan afterwards.

**Errors.** Every error is `application/problem+json` with a stable `code` and the `requestId` that also appears in the logs and in the `X-Request-Id` header:

```sh
curl -s localhost:3000/v1/account
```

```json
{"type":"about:blank","title":"Missing API key","status":401,"code":"MISSING_API_KEY","detail":"Send the X-API-Key header","requestId":"1c3fd081-…"}
```

A wrong, unknown or revoked key gets `401 INVALID_API_KEY`. The answer is the same for all three cases, so it reveals nothing. Admin routes answer `401 MISSING_ADMIN_KEY` or `INVALID_ADMIN_KEY`.

**Isolation.** The account always comes from the key, never from the URL or the body. Another account's users and plans answer `404`, exactly like ids that don't exist, so an account can't even learn that they exist:

```sh
curl -s localhost:3000/v1/users/alice -H "X-API-Key: $OTHER_KEY"   # alice belongs to DocuCorp
```

```json
{"type":"about:blank","title":"User not found","status":404,"code":"USER_NOT_FOUND","detail":"No user 'alice' in this account","requestId":"…"}
```

API keys are revoked in the database (`api_keys.revoked_at`). There is no endpoint for key rotation or revocation (see [Known limitations](#known-limitations)).

## API reference

Every curl example in this README runs in [`docs/api-examples.sh`](docs/api-examples.sh), which checks each status code and the key fields shown here against a running stack. CI runs it on a fresh stack for every pull request. The script runs the [plan changes](#plans-and-changes) before usage and history, which is why those examples show numbers from after the changes. Responses are trimmed (`…`), and ids differ on every run. The full list of error codes is in [DESIGN.md §8.1](DESIGN.md#81-error-codes).

Request bodies are strict: an unknown field is a `400 VALIDATION_ERROR`, with one entry per bad field in `errors`.

### Admin

| Method and path | Description |
| --- | --- |
| `POST /v1/admin/accounts` | Create an account `{ name, planId? }`. Returns the account and its API key, once (shown under [API keys](#api-keys)). Header `X-Admin-Key`. |

### Account

| Method and path | Description |
| --- | --- |
| `GET /v1/account` | The account, its plan, and this month's used and remaining |
| `PUT /v1/account/plan` | Switch the account to a predefined or own custom account plan `{ planId }`. Usage is kept. |

```sh
curl -s localhost:3000/v1/account -H "X-API-Key: $KEY"
# 200 {"id":"9b70fd1f-…","name":"DocuCorp","createdAt":"…","plan":{"id":"…a001","name":"Starter",…},
#      "currentMonth":{"month":"2026-10","used":0,"remaining":10000}}

curl -s -X PUT localhost:3000/v1/account/plan -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"planId":"00000000-0000-4000-8000-00000000a002"}'
# 200 {…,"plan":{"id":"…a002","name":"Pro",…,"rules":{"monthlyAllowance":100000,"maxUnitsPerRequest":500}},
#      "currentMonth":{"month":"2026-10","used":0,"remaining":100000}}
```

### Plans

| Method and path | Description |
| --- | --- |
| `GET /v1/plans?scope=` | The predefined plans and this account's custom plans; `scope` is `account` or `user` |
| `POST /v1/plans` | Create a custom plan `{ name, scope, rules: { monthlyAllowance?, maxUnitsPerRequest? } }` |
| `GET /v1/plans/:planId` | One plan, plus how many of this account's accounts and users use it |
| `PATCH /v1/plans/:planId` | Change a custom plan's `name` and/or `rules`. The version goes up by 1. See [Plans and changes](#plans-and-changes). |

```sh
curl -s 'localhost:3000/v1/plans?scope=user' -H "X-API-Key: $KEY"
# 200 {"plans":[{"id":"…b001","name":"Basic","scope":"user","predefined":true,"version":1,
#                "rules":{"monthlyAllowance":1000,"maxUnitsPerRequest":20},…},
#               {"id":"…b002","name":"Premium",…,"rules":{"monthlyAllowance":5000,"maxUnitsPerRequest":100},…}]}

curl -s -X POST localhost:3000/v1/plans -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"name":"Team","scope":"account","rules":{"monthlyAllowance":60,"maxUnitsPerRequest":50}}'
# 201 {"id":"a671e485-…","name":"Team","scope":"account","predefined":false,"version":1,
#      "rules":{"monthlyAllowance":60,"maxUnitsPerRequest":50},…}
PLAN=a671e485-…   # the id from the response

curl -s -X PUT localhost:3000/v1/account/plan -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d "{\"planId\":\"$PLAN\"}"
# 200 {…,"plan":{"id":"a671e485-…","name":"Team",…},"currentMonth":{"month":"2026-10","used":0,"remaining":60}}

curl -s localhost:3000/v1/plans/$PLAN -H "X-API-Key: $KEY"
# 200 {"id":"a671e485-…","name":"Team",…,"assignments":{"accounts":1,"users":0}}

curl -s -X PATCH localhost:3000/v1/plans/00000000-0000-4000-8000-00000000b001 -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"rules":{"monthlyAllowance":5}}'
# 403 {"type":"about:blank","title":"Plan is read-only","status":403,"code":"PLAN_READ_ONLY",
#      "detail":"Predefined plans cannot be changed",…}
```

### Users

| Method and path | Description |
| --- | --- |
| `POST /v1/users` | Register a user `{ externalId, planId? }`. The default plan is Basic. `409 USER_ALREADY_EXISTS` if the id is taken. |
| `GET /v1/users?limit&cursor` | List users, oldest first, `limit` 1–100 (default 20). Pass `nextCursor` back as `cursor`. |
| `GET /v1/users/:externalId` | One user and its plan |
| `PUT /v1/users/:externalId/plan` | Switch the user's plan `{ planId }`. Usage is kept. |
| `GET /v1/users/:externalId/limits` | This month's limits, used and remaining, for the account and for the user |

`externalId` is 1–200 characters from `A-Z a-z 0-9 . _ : @ -`, compared exactly (case-sensitive).

```sh
curl -s -X POST localhost:3000/v1/users -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"externalId":"alice"}'
# 201 {"externalId":"alice","createdAt":"…","plan":{"id":"…b001","name":"Basic",…}}
curl -s -X POST localhost:3000/v1/users -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"externalId":"bob","planId":"00000000-0000-4000-8000-00000000b002"}'
# 201 {"externalId":"bob",…,"plan":{"id":"…b002","name":"Premium",…}}
curl -s -X POST localhost:3000/v1/users -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"externalId":"carol"}'
# 201

curl -s -X POST localhost:3000/v1/users -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"externalId":"alice"}'
# 409 {…,"code":"USER_ALREADY_EXISTS","detail":"A user 'alice' already exists in this account",…}

curl -s 'localhost:3000/v1/users?limit=2' -H "X-API-Key: $KEY"
# 200 {"users":[{"externalId":"alice","createdAt":"…","plan":{"id":"…b001","name":"Basic"}},
#               {"externalId":"bob",…}],"nextCursor":"WyIyMDI2LTEw…"}
CURSOR=WyIyMDI2LTEw…   # the nextCursor from the response
curl -s "localhost:3000/v1/users?limit=2&cursor=$CURSOR" -H "X-API-Key: $KEY"
# 200 {"users":[{"externalId":"carol",…}],"nextCursor":null}

curl -s localhost:3000/v1/users/bob -H "X-API-Key: $KEY"
# 200 {"externalId":"bob","createdAt":"…","plan":{"id":"…b002","name":"Premium","scope":"user",…}}

curl -s localhost:3000/v1/users/alice/limits -H "X-API-Key: $KEY"
# 200 {"month":"2026-10",
#      "account":{"planId":"a671e485-…","planName":"Team","planVersion":1,"monthlyAllowance":60,
#                 "maxUnitsPerRequest":50,"used":0,"remaining":60},
#      "user":{"planId":"…b001","planName":"Basic","planVersion":1,"monthlyAllowance":1000,
#              "maxUnitsPerRequest":20,"used":0,"remaining":1000}}
```

`remaining` is `null` when there is no monthly rule (unlimited), and never negative.

### Consume

| Method and path | Description |
| --- | --- |
| `POST /v1/consume` | Decide whether `{ userId, units, requestId }` may be processed, and record the decision. Always `200` with `decision` `accepted` or `rejected` when a decision was made. |

The brief's three cases, on the account plan Team (60 per month, at most 50 per request):

```sh
curl -s -X POST localhost:3000/v1/consume -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"userId":"alice","units":25,"requestId":"doc-1"}'
```

```jsonc
// 200: rejected by the user's per-request limit (Basic allows 20)
{
  "requestId": "doc-1", "decision": "rejected", "units": 25, "month": "2026-10",
  "reason": { "scope": "user", "rule": "max_units_per_request", "limit": 20, "actual": 25,
              "message": "User max units per request exceeded: 25 requested > 20" },
  "violations": [ /* every rule that failed, same shape; reason is the first */ ],
  "account": { "planId": "a671e485-…", "planName": "Team", "planVersion": 1, "monthlyAllowance": 60,
               "maxUnitsPerRequest": 50, "used": 0, "remaining": 60 },
  "user":    { "planId": "…b001", "planName": "Basic", "planVersion": 1, "monthlyAllowance": 1000,
               "maxUnitsPerRequest": 20, "used": 0, "remaining": 1000 },
  "replayed": false
}
```

```sh
curl -s -X POST localhost:3000/v1/consume -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"userId":"alice","units":10,"requestId":"doc-2"}'
# 200 {"requestId":"doc-2","decision":"accepted","units":10,"month":"2026-10","violations":[],
#      "account":{…,"used":10,"remaining":50},"user":{…,"used":10,"remaining":990},"replayed":false}

curl -s -X POST localhost:3000/v1/consume -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"userId":"bob","units":45,"requestId":"doc-3"}'
# 200 {…,"decision":"accepted",…,"account":{…,"used":55,"remaining":5},…}

curl -s -X POST localhost:3000/v1/consume -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"userId":"carol","units":10,"requestId":"doc-4"}'
# 200 {…,"decision":"rejected",
#      "reason":{"scope":"account","rule":"monthly_allowance","limit":60,"actual":65,
#                "message":"Account monthly allowance exceeded: 55 used + 10 requested > 60"},…,
#      "account":{…,"used":55,"remaining":5},"user":{…,"used":0,"remaining":1000},…}
```

For an accepted request, `used` and `remaining` are after this request. For a rejected one nothing is counted. Rules are checked in a fixed order (user per-request, account per-request, user monthly, account monthly); `violations` lists every rule that failed and `reason` is the first. Retries are explained in [Consume and retries](#consume-and-retries).

### Usage

| Method and path | Description |
| --- | --- |
| `GET /v1/usage?month&limit&cursor` | One month's used and remaining for the account and for each user. Users are paged like `GET /v1/users`. |
| `GET /v1/users/:externalId/usage?month` | One user's used and remaining for one month |

`month` is `YYYY-MM` (UTC). Without it, the current month by the database clock. Any other format is `400 VALIDATION_ERROR`. A month without data is not an error: every `used` is `0`.

```sh
curl -s localhost:3000/v1/usage -H "X-API-Key: $KEY"
# 200 {"month":"2026-10",
#      "account":{"planId":"a671e485-…","planName":"Team","monthlyAllowance":50,"used":90,"remaining":0},
#      "users":[{"userId":"alice","planName":"Premium","monthlyAllowance":5000,"used":35,"remaining":4965},
#               {"userId":"bob",…,"used":45,…},{"userId":"carol",…,"used":10,…}],
#      "nextCursor":null}

curl -s 'localhost:3000/v1/users/alice/usage?month=2026-10' -H "X-API-Key: $KEY"
# 200 {"month":"2026-10","userId":"alice","planId":"…b002","planName":"Premium","monthlyAllowance":5000,
#      "used":35,"remaining":4965}

curl -s 'localhost:3000/v1/usage?month=2020-01' -H "X-API-Key: $KEY"
# 200 {"month":"2020-01","account":{…,"used":0,…},"users":[…every user with "used":0…],"nextCursor":null}

curl -s 'localhost:3000/v1/usage?month=2026-13' -H "X-API-Key: $KEY"
# 400 {…,"code":"VALIDATION_ERROR","errors":[{"path":"query.month","message":"must be a month as YYYY-MM"}],…}
```

(These numbers are from after the plan changes in [Plans and changes](#plans-and-changes); the script runs them in that order.)

For a past month, `remaining` is computed against the plan assigned **now**. The limits that each decision was actually checked against are in its history entry.

### History

| Method and path | Description |
| --- | --- |
| `GET /v1/requests?userId&month&decision&include&limit&cursor` | The account's decisions, newest first. Filters combine. `include=evaluation` adds the full response stored at decision time. `limit` 1–100 (default 20); pass `nextCursor` back as `cursor`. |

```sh
curl -s 'localhost:3000/v1/requests?userId=alice' -H "X-API-Key: $KEY"
# 200 {"requests":[
#   {"requestId":"doc-7","userId":"alice","units":25,"decision":"accepted","reason":null,"month":"2026-10",
#    "createdAt":"…","accountPlan":{"id":"a671e485-…","version":2},"userPlan":{"id":"…b002","version":1}},
#   {"requestId":"doc-2",…,"decision":"accepted","reason":null,…},
#   {"requestId":"doc-1",…,"decision":"rejected","reason":{"scope":"user","rule":"max_units_per_request"},…}],
#  "nextCursor":null}

curl -s 'localhost:3000/v1/requests?decision=rejected&include=evaluation' -H "X-API-Key: $KEY"
# 200 {"requests":[{"requestId":"doc-4",…,"evaluation":{"requestId":"doc-4","decision":"rejected",
#        "reason":{"scope":"account","rule":"monthly_allowance","limit":60,"actual":65,…},…}},
#      {"requestId":"doc-1",…}],"nextCursor":null}
```

An unknown `userId` filter is `404 USER_NOT_FOUND`, so a typo is visible instead of an empty page.

### Operations

| Method and path | Description |
| --- | --- |
| `GET /health/live` | `200` while the process runs. Never touches the database. |
| `GET /health/ready` | `200` if the database answers and the latest migration is applied, else `503` |
| `GET /metrics` | Prometheus metrics: latency by route pattern, consume decisions, transaction, pool and lock timings ([DESIGN.md §12](DESIGN.md#12-observability)) |

None of these need a key.

```sh
curl -s localhost:3000/health/live    # 200 {"status":"ok"}
curl -s localhost:3000/health/ready   # 200 {"status":"ok"}
curl -s localhost:3000/metrics | grep '^consume_decisions_total'
# consume_decisions_total{decision="accepted",scope="none",rule="none"} …   (a count since the API started)
```

## Consume and retries

**Why a rejection is `200`.** The request was valid and a decision was made and recorded. The decision is data. `4xx` and `5xx` mean the call itself failed. This keeps client code simple: on `200`, read `decision`; anything else is a problem with the call.

**`requestId` is the idempotency key.** It is chosen by the client (1–200 characters), unique per account, and names one decision forever. Send the same request again, for example after a timeout, and you get the **original** decision back. Nothing is counted twice.

```sh
curl -s -i -X POST localhost:3000/v1/consume -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"userId":"alice","units":10,"requestId":"doc-2"}'
# HTTP/1.1 200 OK
# Idempotent-Replayed: true
# {"requestId":"doc-2","decision":"accepted",…,"account":{…,"used":10,"remaining":50},…,"replayed":true}
```

The replayed body is the response from decision time (`used` 10 here, although the account has used more since). A replay answers "what was decided for this request?". For the current numbers, use `GET /v1/users/:externalId/limits`.

```sh
curl -s -X POST localhost:3000/v1/consume -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"userId":"alice","units":11,"requestId":"doc-2"}'
# 409 {…,"code":"IDEMPOTENCY_CONFLICT",
#      "detail":"requestId 'doc-2' was already used for a different request (userId 'alice', units 10)",…}
```

| Situation | Answer | Recorded? |
| --- | --- | --- |
| New `requestId` | `200` accepted or rejected | yes |
| Same `requestId`, same `userId` and `units` | `200`, the stored decision, `replayed: true` | no (already recorded) |
| Same `requestId`, different `userId` or `units` | `409 IDEMPOTENCY_CONFLICT` | no |
| Same `requestId` after a rejection, once the plan allows it | `200`, the stored **rejection**. Send a new `requestId` to try again. | no |
| Invalid body (`400`), bad key (`401`), unknown user (`404 USER_NOT_FOUND`) | the error | no: fix the call and resend with the same `requestId` |
| `503 SERVICE_BUSY` | too much waiting on one account (lock wait over 2 s or statement over 5 s) | no: retry with the same `requestId` |
| `503 SERVICE_UNAVAILABLE` | the database could not be reached | maybe: retry with the same `requestId`. If the decision was stored before the connection broke, you get it as a replay; otherwise it is decided then. |

Two identical requests that arrive at the same moment are decided once: the second one loses on the ledger's unique key, its whole transaction (including any counting) rolls back, and it answers with the first one's decision as a replay.

```sh
curl -s -X POST localhost:3000/v1/consume -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"userId":"zoe","units":1,"requestId":"doc-5"}'
# 404 {…,"code":"USER_NOT_FOUND","detail":"No user 'zoe' in this account",…}
curl -s -X POST localhost:3000/v1/consume -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"userId":"alice","units":0,"requestId":"doc-5"}'
# 400 {…,"code":"VALIDATION_ERROR","errors":[{"path":"body.units","message":"Too small: expected number to be >=1"}],…}
```

## Plans and changes

**Predefined plans** (fixed ids, created on startup, read-only):

| Plan | Scope | Id | Monthly allowance | Max per request |
| --- | --- | --- | --: | --: |
| Starter | account | `00000000-0000-4000-8000-00000000a001` | 10,000 | 100 |
| Pro | account | `00000000-0000-4000-8000-00000000a002` | 100,000 | 500 |
| Basic | user | `00000000-0000-4000-8000-00000000b001` | 1,000 | 20 |
| Premium | user | `00000000-0000-4000-8000-00000000b002` | 5,000 | 100 |

New accounts get Starter and new users get Basic, unless the request names another plan.

**Custom plans** belong to the account that created it. Only that account sees and assigns them. Names are unique per account and scope (case-insensitive; `409 PLAN_NAME_TAKEN`). An account plan can't be given to a user or the other way round (`400 INVALID_PLAN_SCOPE`). Plans are never deleted.

**Changing a custom plan** (`PATCH /v1/plans/:planId`): a number sets a rule, `null` removes it (no limit), and a missing field leaves it as it is. Every change raises `version` by 1. All accounts or users on the plan get the new rules from their next request:

```sh
curl -s -X PATCH localhost:3000/v1/plans/$PLAN -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"rules":{"monthlyAllowance":200}}'
# 200 {"id":"a671e485-…","name":"Team",…,"version":2,"rules":{"monthlyAllowance":200,"maxUnitsPerRequest":50},…}

curl -s -X PUT localhost:3000/v1/users/alice/plan -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"planId":"00000000-0000-4000-8000-00000000b002"}'
# 200 {"externalId":"alice",…,"plan":{"id":"…b002","name":"Premium",…}}

curl -s -X POST localhost:3000/v1/consume -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"userId":"carol","units":10,"requestId":"doc-6"}'
# 200 {…,"decision":"accepted",…,"account":{…,"planVersion":2,"monthlyAllowance":200,"used":65,"remaining":135},…}
curl -s -X POST localhost:3000/v1/consume -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"userId":"alice","units":25,"requestId":"doc-7"}'
# 200 {…,"decision":"accepted",…,"user":{…,"planName":"Premium",…,"used":35,"remaining":4965},…}

curl -s -X PATCH localhost:3000/v1/plans/$PLAN -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"rules":{"maxUnitsPerRequest":null}}'
# 200 {…,"version":3,"rules":{"monthlyAllowance":200,"maxUnitsPerRequest":null},…}

curl -s -X PATCH localhost:3000/v1/plans/$PLAN -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"rules":{"monthlyAllowance":50}}'
# 200 {…,"version":4,"rules":{"monthlyAllowance":50,"maxUnitsPerRequest":null},…}
curl -s localhost:3000/v1/users/carol/limits -H "X-API-Key: $KEY"
# 200 {"month":"2026-10","account":{…,"monthlyAllowance":50,"maxUnitsPerRequest":null,"used":90,"remaining":0},…}
```

- **Switching plans keeps usage.** alice used 10 on Basic. After the switch to Premium, her 25 makes 35 against Premium's 5,000. There is no fresh allowance.
- **Lowering an allowance below usage** gives `remaining: 0` (never negative), and that level rejects further requests until the next month or an increase.
- **In-flight requests.** Plans are read inside the consume transaction, with no cache. A request that starts after the change commits always sees the new rules. A request already running when it commits may finish with the old ones. Its ledger entry records the plan version it used, so this is visible in the history.
- **History keeps the past.** Each decision stores the plan versions and the full response it was evaluated with (`include=evaluation`), so later plan edits don't change it.

## Demo app

Open **http://localhost:8080** after `docker compose up --build`. The demo is **DocuCorp**, a client application that asks the metering API before it processes each document.

**Where the keys are.** The page talks only to the demo's own server (`demo-app/`). That server holds DocuCorp's API key and calls the metering API, so no API key reaches the browser. The request JSON on the page names the key header but never contains a key. The demo server also holds `ADMIN_API_KEY`, because it plays the operator who creates accounts. A real client app would have only its own account's API key.

**On startup** the demo server waits for `/health/ready`, creates DocuCorp once with the admin key, and keeps the key in `/data/docucorp.json` on the `demo-data` volume (the API shows a key only once). It creates the custom account plan **Demo Team** (60 per month, at most 50 per request) and the users **alice (Basic)**, **bob (Premium)** and **carol (Basic)**. A restart reuses all of them and keeps your free-play usage. If the database was reset but the demo volume kept, the old key gets `401`, and the demo creates a new DocuCorp.

**Guided scenario.** **Run guided scenario** creates a fresh account each time, with its own Demo Team plan and users, so free play can't change the result:

| Step | Action | Expected | What it shows |
| --- | --- | --- | --- |
| 1 | alice (Basic) processes 10 | accepted | A request within every limit |
| 2 | alice processes 25 | rejected: user `max_units_per_request` (Basic = 20) | The user's per-request limit |
| 3 | bob (Premium) processes 45 | accepted; the account has 5 left | Usage counts against the shared account |
| 4 | carol (Basic) processes 10 | rejected: account `monthly_allowance` | The account limit binds even when the user has plenty left |
| 5 | `PATCH` Demo Team to 200 per month; `PUT` alice on Premium | both `200` | Limits change by configuration, with no code change |
| 6 | carol processes 10; alice processes 25 | both accepted | Changes apply to the next request; usage is kept across the plan switch |

Each step shows a one-line explanation, the decision (ACCEPTED or REJECTED, with a USER LIMIT or ACCOUNT LIMIT badge and one sentence for a rejection), the remaining units, a pass or fail mark against the expected outcome, and the raw request and response (collapsed). Each run leaves one `Scenario <timestamp>` account behind; accounts are not deleted.

**Free play**, below the scenario:

| Part | What it does |
| --- | --- |
| Shared account | DocuCorp's plan and this month's used and remaining. Every user draws from it. |
| User cards | Each user's plan and allowance, a units field and **Process document** (a new `requestId` each time). After a request: the decision, the remaining units and the raw JSON. **Retry last request** sends the same `requestId` again and shows `replayed: true`. |
| Configuration | Change a user's plan or Demo Team's limits. These are API calls with data; the code that processes documents stays the same. |
| Recent requests | The last 10 decisions from `GET /v1/requests` |

An API error appears as a banner with the status, the `code` and whether the demo server or the metering API refused.

**Smoke test** (with the stack running; CI runs the same on a fresh stack):

```sh
cd demo-app && npm ci && npm run smoke   # DEMO_URL defaults to http://localhost:8080
```

It runs the guided scenario and checks all six outcomes from the raw API responses. It also checks a process and retry (`replayed: true`), that an API error reaches the page, and that no response to the page contains an `mk_` key.

## Tests

The tests run against a real, separate PostgreSQL (`db-test`, profile `test`, port 5433). They need Node 22 or newer.

```sh
docker compose --profile test up -d --wait db-test
cd api
npm ci
npm test                                   # all 198 tests in 21 files, a few seconds
npx vitest run test/unit                   # only the rules engine and other pure code
npx vitest run test/integration            # every endpoint, auth, isolation, errors
npx vitest run test/concurrency            # parallel consumes against the real database
```

The suite migrates and seeds the test database itself. Every test creates its own fresh account, so tests never share data and nothing needs cleaning up. It reads only `TEST_DATABASE_URL` (default `postgres://metering:metering@localhost:5433/metering_test`) and ignores `DATABASE_URL`, so it can never run against the dev database. Other scripts in `api/`: `npm run typecheck`, `npm run build`, `npm run dev` (watch mode, reads `../.env`).

**What the concurrency tests prove** (`api/test/concurrency/`):

- 50 parallel requests of 5 units against an allowance of 100: exactly 20 accepted, `used` is exactly 100, and every counter equals the sum of its accepted ledger rows.
- 30 parallel requests with the same `requestId`: one ledger row, one increment, one decision for all 30.
- Parallel requests for one user against both limits never over-grant either level.
- 40 parallel requests while the user's plan flips between 10 and 30 per request: every accepted request fits the limits of the plan version it records.
- 5 accounts × 20 parallel requests with the same `requestId`s: exact totals per account, nothing crosses accounts.
- The two counter rows are always locked account first, then user, so concurrent requests can't deadlock.

**The lock matters, and the tests show it.** With the row lock on the counters removed, the first test accepted 36–37 of the 50 requests (180–185 units against an allowance of 100). Under load, the `exhaust` scenario accepted 10,190 units against 10,000. Both checks fail loudly.

## Performance

**How it was tested.** [k6](https://k6.io) scenarios in [`load/`](load/) run in Docker against the API, then [`load/verify.sql`](load/verify.sql) checks every counter against the ledger over the whole database and fails the run if anything is off. A number counts only if that check passed. Each scenario ran 3 times on a fresh stack, and the tables show medians.

| Scenario | Shape |
| --- | --- |
| `spread` | 200 accounts × 5 users, 100 clients, 60 s: no contention |
| `hot-account` | 1 account, 500 users, 100 clients, 60 s: every request on one account |
| `hot-user` | 1 user, 100 clients, 60 s |
| `exhaust` | allowance 10,000, 2,000 requests of 10 units at once: exactly 10,000 must be accepted |
| `retry-storm` | 100 fixed requests resent by 100 clients for 30 s: one decision per `requestId` |
| `plan-flip` | 50 clients while another changes the user plan every ~100 ms |

**Machine.** One laptop: Intel i7-12650H (10 cores, 16 threads), 15 GiB RAM, Ubuntu 24.04, Docker without CPU or memory limits. **k6 runs on the same machine** as the API and the database, so the numbers are for comparing versions on this machine, not for capacity planning.

**Before and after.** The 6a baseline (the first working version) against the final code, run alternately in one session so that machine drift affects both alike:

| Scenario | Baseline req/s | Final req/s | Change | p99 latency |
| --- | --: | --: | --: | --: |
| hot-account | 259 | 338 | +30 % | 715 → 544 ms |
| spread | 1,916 | 2,178 | +14 % | 75 → 68 ms |
| retry-storm | 3,255 | 2,979 | −9 % | 45 → 51 ms |

All six scenarios with the final code (3 runs each), next to the baseline run from another session:

| Scenario | Baseline req/s | Final req/s | Final p50 / p95 / p99 ms | Errors | verify.sql |
| --- | --: | --: | --: | --: | --- |
| spread | 1,841 | 2,196 | 44 / 56 / 67 | 0 % | passed 3/3 |
| hot-account | 322 | 333 | 280 / 441 / 552 | 0 % | passed 3/3 |
| hot-user | 296 | 331 | 282 / 443 / 556 | 0 % | passed 3/3 |
| exhaust | 306 | 334 | 276 / 431 / 524 | 0 % | passed 3/3 |
| retry-storm | 3,120 | 2,971 | 33 / 40 / 50 | 0 % | passed 3/3 |
| plan-flip | 483 | 569 | 69 / 217 / 323 | 0 % | passed 3/3 |

`exhaust` accepted exactly 10,000 units and `retry-storm` wrote exactly one ledger row per `requestId` in every run. The laptop's speed varies by 10–15 % between sessions, which is why the first table, with alternating runs, is the fair comparison. hot-account looks flat in the second table only because the baseline was recorded on a faster day.

**Where the time goes, in plain words.**

- **One busy account.** Every request for an account has to lock that account's counter row, and they take turns. So one account can do at most 1 ÷ (how long each request holds the lock) requests per second. At first the lock was held for about 3.2 ms, mostly waiting for 5 round trips to the database. Doing the same work in 3 round trips cut that to about 2.6 ms, which gave the +30 %. Adding database connections doesn't help here; it only makes requests wait longer at the lock.
- **Many accounts.** Requests don't wait for each other, and the limit is the API process itself: Node runs the JavaScript on one thread, and that thread was 93–98 % busy. Fewer database round trips per request saved it work (+14 %). More API instances would be the next step; the database used about 3.4 of 16 cores.
- **Retries got slower.** Since one change merged two lookups into one query, a replayed request also loads the user and plans, which costs Postgres more planning time (−9 % on `retry-storm`). Replays are rare in normal use. Prepared statements are the likely fix (not built).

**Reproduce.** Needs Docker with Compose v2, bash and curl. k6 (`grafana/k6:2.3.0`) and the Node helper scripts run in containers.

```sh
load/run.sh hot-account check                  # one scenario: fresh accounts, k6, verify.sql, one summary line (≈ 75 s)
load/run-all.sh mylabel 3                      # all six scenarios, 3 runs each, each on a fresh stack (≈ 19 min)
load/run-all.sh mylabel 3 spread hot-account   # only these scenarios
```

`run-all.sh`, and `run.sh` with `FRESH_STACK=1`, run `docker compose down -v` first, which deletes the dev database and the demo's data. Results go to `load/results/<label>/`. The full method, every step that was tried (including the ones that didn't help) and the raw results are in [docs/performance.md](docs/performance.md).

## Design decisions

Short versions; [DESIGN.md](DESIGN.md) has the reasoning and the rejected alternatives.

- **Counters and a ledger.** One counter row per account per month and per user per month makes each check a single row read. The append-only ledger keeps every decision, and it is how the counters are verified (each counter equals the sum of its accepted ledger rows).
- **Row locks under `READ COMMITTED`, in a fixed order.** A consume locks the account's counter row, then the user's, before it checks the monthly rules, so two requests for the same account can't both pass on the same stale number. The fixed order (account, then user) means no deadlocks. `SERIALIZABLE` would also be correct, but under contention it aborts transactions that would have to be retried exactly when load is highest.
- **Idempotency through a unique key in the same transaction.** `UNIQUE (account_id, request_id)` on the ledger, written in the same transaction as the counters. A duplicate either finds the stored decision or loses on the unique key and rolls back, counters included.
- **Rules are data, read inside the transaction.** Plans and rules are table rows read by every consume, with no cache. A plan change applies to the next request with no redeploy, and there is no cache to get stale.
- **Each decision stores its snapshot.** The ledger row keeps the plan versions and the exact response, so history and replays stay correct after plans change.
- **Raw SQL with `pg`.** Locking and round trips must be visible in the code. An ORM would hide the `ON CONFLICT … DO UPDATE` that takes the lock and the number of queries per request.
- **Express 5 and TypeScript.** A well-known framework, so the time went into correctness. Express 5 passes errors from async handlers to one error handler. The measured limits are the row lock and the Node thread, not the framework.
- **No API key cache.** One indexed lookup per request (about 0.01 ms in Postgres). A 30 s cache was built and measured: no throughput gain, and a revoked key would keep working for 30 s. It was removed.

## Product assumptions

The brief leaves these open; this is how the service behaves, and why. The same list is [DESIGN.md §16](DESIGN.md#16-product-assumptions).

1. **Accounts are created by an operator** with `ADMIN_API_KEY`. There is no self-service signup, because end-user login is out of scope.
2. **Users must be registered before they consume.** An unknown user is `404`. Creating users on first use would silently turn a typo into a new user.
3. **Default plans:** a new account gets Starter and a new user gets Basic, unless a plan is given, so every account and user always has a plan.
4. **A missing rule means no limit** at that level. A limit of `0` is valid and blocks consumption. This lets a plan limit one dimension only.
5. **Units are whole numbers from 1 to 1,000,000,000 per request.** The upper bound is an input sanity check, separate from plan rules.
6. **`requestId` is chosen by the client, 1–200 characters, unique per account, and names one decision forever, including a rejection.** Retries are then always safe, and two accounts can't collide.
7. **Rejected requests are recorded** in the history but consume nothing, so a client can see why something was refused.
8. **No partial acceptance.** A request is accepted in full or not at all, because a client can't process half a document.
9. **The month is the UTC calendar month by the database clock**, so all API instances agree and one transaction never spans two months.
10. **Lowering an allowance below usage** gives `remaining: 0` and rejects further requests at that level until the next month or an increase. It never goes negative.
11. **Switching plans mid-month keeps the units already used.** The new plan's limits are compared with the same counter, so switching can't be used to get a fresh allowance.
12. **Predefined plans are read-only and visible to every account; custom plans are private** to the account that created them.
13. **Plans are never deleted**, and there is no `DELETE` endpoint. Every ledger row references the plan and version it was checked against, so deleting a plan would break history or rewrite it. An unused custom plan simply stays unassigned.
14. **Users and accounts are never deleted**, so their history is kept. Deletion is out of scope.
15. **For a past month, `remaining` is computed against the plan assigned now.** There is no plan history table; the limits actually applied are in each ledger entry.
16. **New accounts start on a predefined plan.** A custom plan belongs to an account, so none can exist before the account does. Switch to a custom plan afterwards.
17. **`externalId` is 1–200 characters from `A-Z a-z 0-9 . _ : @ -`, case-sensitive.** It appears in URLs and logs, so it excludes everything that would need escaping. Clients map other identifiers (emails with `+`, non-ASCII names) to an id in this charset.

## Known limitations

- **One account is limited by one row.** Every request for an account waits its turn on that account's counter row: about 330 requests per second for one account on the test laptop. Sharded counters or pre-allocated quota slices would remove this (not built; see [docs/performance.md](docs/performance.md#what-we-would-do-next-not-built)).
- **The ledger grows forever.** It is not partitioned, and idempotency keys are kept forever. Monthly partitioning is the next step at scale.
- **Nothing is ever deleted:** plans, users and accounts stay. The demo's guided scenario adds one `Scenario <timestamp>` account per run.
- **Requests in flight during a plan update may use the previous version.** The ledger records which version each one used.
- **No rate limiting of the API itself** (separate from quota), no roles within an account, no billing.
- **No key rotation or revocation endpoint.** An account has the one key it got at creation; revoking it means setting `revoked_at` in the database.
- **The performance numbers come from one laptop with k6 on the same machine**, and vary 10–15 % between sessions.
- **Replays got 9 % slower in Phase 6b** (`retry-storm`), because the merged lookup costs Postgres more planning. Named prepared statements are the likely fix (not built).
- The optional `daily_allowance` rule ([DESIGN.md §5.1](DESIGN.md#51-optional-extra-rule-not-built)) is designed but **not built**.

## Repository layout

```
.
├── api/                  the metering API (TypeScript, Express 5, pg)
│   ├── src/http/         routes, middleware (auth, validation, errors, logging, metrics), JSON views
│   ├── src/services/     use cases; consume.ts is the decision
│   ├── src/domain/       the rules engine and other pure code
│   ├── src/repositories/ all SQL
│   ├── src/db/           pool, transactions, migrations, seed
│   └── test/             unit, integration and concurrency tests
├── demo-app/             the example client: its own server, one static page, the smoke test
├── load/                 k6 scenarios, setup, verify.sql, run scripts, results of every run
├── docs/                 performance.md, api-examples.sh, media/ (the demo GIF and video)
├── docker-compose.yml    db, api, demo; profiles test (db-test) and loadtest (k6)
└── DESIGN.md             the full design
```
