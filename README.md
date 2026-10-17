# Usage Metering & Quota Service

An HTTP service that decides, before an application processes a unit of work, whether an account and one of its users still have quota for it. Each account and each user has a plan (a monthly allowance and a per-request limit). A consume call is accepted only if both levels pass, and every decision goes into a ledger. It is built with TypeScript, Express 5 and PostgreSQL 16, and correctness under concurrency is enforced by the database. See [DESIGN.md](DESIGN.md) for the full design. It is the source of truth for this project.

> Status: Phase 6a. Accounts, API keys, plans, users, effective limits, `POST /v1/consume`, monthly usage, decision history, the demo app, Prometheus metrics and the load-test harness with baseline numbers exist. Optimizations measured against that baseline come next. See [DESIGN.md §18](DESIGN.md#18-build-order).

## Run it

Requires Docker with Compose v2.

```sh
docker compose up --build
curl localhost:3000/health/ready   # {"status":"ok"}
```

This starts three services: `db`, `api` and `demo`. Open the demo at **http://localhost:8080** (see [Demo](#demo)). The API listens on `localhost:3000`. On startup it applies database migrations and seeds the predefined plans. Both steps are safe to repeat on every start. Optional settings (`ADMIN_API_KEY`, `LOG_LEVEL`, `DB_POOL_MAX`) can go in a `.env` file; see [.env.example](.env.example).

| Endpoint                     | Auth          | Meaning                                                        |
| ---------------------------- | ------------- | -------------------------------------------------------------- |
| `GET /health/live`           | none          | 200 while the process is up                                    |
| `GET /health/ready`          | none          | 200 if the database answers and the latest migration is applied, else 503 |
| `GET /metrics`               | none          | Prometheus metrics: request latency by route pattern, consume decisions, transaction and pool timings ([DESIGN.md §12](DESIGN.md#12-observability)) |
| `POST /v1/admin/accounts`    | `X-Admin-Key` | Create an account `{ name, planId? }`; returns its first API key, once |
| `GET /v1/account`            | `X-API-Key`   | The caller's account, its plan, and this month's used/remaining |
| `PUT /v1/account/plan`       | `X-API-Key`   | Switch to a predefined or own custom account plan `{ planId }` |
| `GET /v1/plans?scope=`       | `X-API-Key`   | Predefined plans + this account's custom plans                 |
| `POST /v1/plans`             | `X-API-Key`   | Create a custom plan `{ name, scope, rules: { monthlyAllowance?, maxUnitsPerRequest? } }` |
| `GET /v1/plans/:planId`      | `X-API-Key`   | One plan + how many of this account's account/users use it     |
| `PATCH /v1/plans/:planId`    | `X-API-Key`   | Change a custom plan's name/rules (`null` removes a rule); version +1 |
| `POST /v1/users`             | `X-API-Key`   | Register a user `{ externalId, planId? }` (default Basic)       |
| `GET /v1/users?limit&cursor` | `X-API-Key`   | List users, oldest first; pass `nextCursor` back as `cursor`   |
| `GET /v1/users/:externalId`  | `X-API-Key`   | One user and its plan                                          |
| `PUT /v1/users/:externalId/plan` | `X-API-Key` | Switch a user's plan `{ planId }` (usage is kept)             |
| `GET /v1/users/:externalId/limits` | `X-API-Key` | This month's limits, used and remaining for the account and the user |
| `POST /v1/consume`           | `X-API-Key`   | Decide and record `{ userId, units, requestId }`: 200 with `decision` accepted or rejected |
| `GET /v1/usage?month&limit&cursor` | `X-API-Key` | A month's used/remaining for the account and each user (users paginated like `GET /v1/users`) |
| `GET /v1/users/:externalId/usage?month` | `X-API-Key` | One user's used/remaining for a month                      |
| `GET /v1/requests?userId&month&decision&include&limit&cursor` | `X-API-Key` | Decision history, newest first; filters combine; `include=evaluation` adds the stored snapshot |

Plans are never deleted (see [DESIGN.md §16](DESIGN.md#16-product-assumptions-to-copy-into-the-readme)). New accounts can start only on a predefined plan. A missing rule means unlimited, and a limit of `0` blocks consumption. A user's `externalId` is 1–200 characters from `A-Z a-z 0-9 . _ : @ -`, because it appears in URLs and logs.

### Try it

```sh
# Without a .env, compose uses this dev-only admin key.
ADMIN=dev-admin-key-change-me-0123456789abcdef

curl -s -X POST localhost:3000/v1/admin/accounts \
  -H "X-Admin-Key: $ADMIN" -H 'Content-Type: application/json' \
  -d '{"name":"DocuCorp"}'
# → 201 { "account": {...}, "apiKey": { "key": "mk_…" } }   (the key is shown only here)

curl -s localhost:3000/v1/account -H "X-API-Key: mk_…"

# Switch to Pro
curl -s -X PUT localhost:3000/v1/account/plan -H "X-API-Key: mk_…" \
  -H 'Content-Type: application/json' -d '{"planId":"00000000-0000-4000-8000-00000000a002"}'

# Create a custom account plan, then assign it
curl -s -X POST localhost:3000/v1/plans -H "X-API-Key: mk_…" -H 'Content-Type: application/json' \
  -d '{"name":"Demo Team","scope":"account","rules":{"monthlyAllowance":60,"maxUnitsPerRequest":50}}'
curl -s -X PUT localhost:3000/v1/account/plan -H "X-API-Key: mk_…" \
  -H 'Content-Type: application/json' -d '{"planId":"<id from above>"}'

# Raise its allowance; every account/user on the plan gets it from the next request
curl -s -X PATCH localhost:3000/v1/plans/<id> -H "X-API-Key: mk_…" \
  -H 'Content-Type: application/json' -d '{"rules":{"monthlyAllowance":200}}'

# Register users and read alice's effective limits
curl -s -X POST localhost:3000/v1/users -H "X-API-Key: mk_…" \
  -H 'Content-Type: application/json' -d '{"externalId":"alice"}'
curl -s -X POST localhost:3000/v1/users -H "X-API-Key: mk_…" \
  -H 'Content-Type: application/json' -d '{"externalId":"bob","planId":"00000000-0000-4000-8000-00000000b002"}'
curl -s localhost:3000/v1/users/alice/limits -H "X-API-Key: mk_…"

# Consume: 200 either way, with decision "accepted" or "rejected" and the reason
curl -s -X POST localhost:3000/v1/consume -H "X-API-Key: mk_…" \
  -H 'Content-Type: application/json' -d '{"userId":"alice","units":10,"requestId":"doc-1"}'
```

### Usage and history

```sh
# This month (UTC, by the database clock): the account, then each user, 20 per page
curl -s localhost:3000/v1/usage -H "X-API-Key: mk_…"
# → { "month": "2026-10",
#     "account": { "planId": "…", "planName": "Starter", "monthlyAllowance": 10000, "used": 55, "remaining": 9945 },
#     "users": [ { "userId": "alice", "planName": "Basic", "monthlyAllowance": 1000, "used": 10, "remaining": 990 }, … ],
#     "nextCursor": null }

# A past month, and the next page of users
curl -s 'localhost:3000/v1/usage?month=2026-09&limit=50' -H "X-API-Key: mk_…"
curl -s 'localhost:3000/v1/usage?cursor=<nextCursor>' -H "X-API-Key: mk_…"

# One user
curl -s 'localhost:3000/v1/users/alice/usage?month=2026-10' -H "X-API-Key: mk_…"

# History: newest first. Filters combine; pass nextCursor back as cursor for older entries
curl -s 'localhost:3000/v1/requests?userId=alice' -H "X-API-Key: mk_…"
curl -s 'localhost:3000/v1/requests?decision=rejected&month=2026-10&limit=50' -H "X-API-Key: mk_…"
# → { "requests": [ { "requestId": "doc-2", "userId": "alice", "units": 25, "decision": "rejected",
#                     "reason": { "scope": "user", "rule": "max_units_per_request" }, "month": "2026-10",
#                     "createdAt": "…", "accountPlan": { "id": "…", "version": 1 }, "userPlan": { "id": "…", "version": 1 } } ],
#     "nextCursor": null }

# Add the full decision snapshot (limits, used/remaining, violations as they were then)
curl -s 'localhost:3000/v1/requests?userId=alice&include=evaluation' -H "X-API-Key: mk_…"
```

- `month` is `YYYY-MM`; anything else is `400 VALIDATION_ERROR`. A month without data shows `used: 0`.
- **`remaining` for a past month is computed against the plan assigned now**, not the plan that applied then. The limits each decision was actually checked against are in its history entry (plan versions, and `include=evaluation`).
- An unknown `userId` filter is `404 USER_NOT_FOUND`. You only ever see your own account's data.

### Consume and retries

`requestId` is your idempotency key, unique per account. Send the same `requestId` again (for example after a timeout) and you get the **original** decision back with `"replayed": true` and the header `Idempotent-Replayed: true`. Nothing is counted twice. The replayed body is the response as it was at decision time, not current numbers.

- The same `requestId` with a different `userId` or `units` → `409 IDEMPOTENCY_CONFLICT`.
- A `requestId` names one decision forever, including a rejection. After upgrading a plan, send a **new** `requestId` to try again.
- `400` (invalid body), `401` and `404 USER_NOT_FOUND` are not recorded, so you can fix the call and resend the same `requestId`.
- `503 SERVICE_BUSY` means nothing was recorded; retry with the same `requestId`.
- `503 SERVICE_UNAVAILABLE` means the database could not be reached. Retry with the same `requestId`: if the decision was stored just before the connection broke you get it back as a replay, otherwise it is decided then.

Predefined plan ids (fixed, from [`api/src/db/seed.ts`](api/src/db/seed.ts)):

| Plan    | Scope   | Id                                     | Monthly | Max / request |
| ------- | ------- | -------------------------------------- | ------- | ------------- |
| Starter | account | `00000000-0000-4000-8000-00000000a001` | 10,000  | 100           |
| Pro     | account | `00000000-0000-4000-8000-00000000a002` | 100,000 | 500           |
| Basic   | user    | `00000000-0000-4000-8000-00000000b001` | 1,000   | 20            |
| Premium | user    | `00000000-0000-4000-8000-00000000b002` | 5,000   | 100           |

Errors are `application/problem+json` with a stable `code` and the `requestId`. The full list of codes is in [DESIGN.md §8.1](DESIGN.md#81-error-codes).

## Demo

Open **http://localhost:8080** after `docker compose up --build`. The demo plays **DocuCorp**, a client application that asks the metering API before it processes each document.

**Where the keys are.** The page talks only to the demo server (`demo-app/`). The demo server holds DocuCorp's API key and calls the metering API, so no API key ever reaches the browser. The request JSON shown on the page names the key header but never contains the key. The demo server also holds `ADMIN_API_KEY`, because it plays the operator who creates accounts. **A real client app would only have its own account's API key.**

On startup the demo server waits for `/health/ready`, then sets up DocuCorp. This is safe to repeat on every start:

- It creates the DocuCorp account once with the admin key. The API shows an account's key only once, so the demo keeps it in `/data/docucorp.json` on the `demo-data` volume, and restarts reuse it.
- It creates the custom account plan **Demo Team** (monthly 60, max 50 per request), assigns it, and registers **alice (Basic)**, **bob (Premium)** and **carol (Basic)**. A `409` means "already exists": the demo looks the object up and leaves it unchanged, so a restart keeps your free-play usage and configuration changes.

What the page shows, top to bottom:

| Part                | What it shows                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Guided scenario     | The brief's story, step by step, with the decision and a pass/fail mark against the expected outcome for each step (below).                      |
| Shared account      | DocuCorp's plan and this month's used/remaining. This is the one place for account usage; every user draws from it.                            |
| User cards          | Each user's plan and per-request max, one bar for the user's own allowance, a units input and **Process document** (a new `requestId` every time). After a request: a large **ACCEPTED** / **REJECTED** with the units; for a rejection a **USER LIMIT** or **ACCOUNT LIMIT** badge and one plain sentence; then "remaining: user X · account Y" and the raw JSON. **Retry last request** (shown after the first request) sends the same `requestId` again and gets the stored decision with `replayed: true`. |
| Configuration       | Change a user's plan (`PUT /v1/users/:id/plan`) or Demo Team's limits (`PATCH /v1/plans/:id`). These are API calls with data. The code that processes documents doesn't change. |
| Recent requests     | The last 10 decisions from `GET /v1/requests`.                                                                                                   |
| How this demo works | Collapsed: where the keys are, what the scenario runs on, how to reset.                                                                          |

API errors (4xx/5xx) show as a banner with the status, the `code`, the message and whether the demo server or the metering API refused.

### Guided scenario

**Run guided scenario** creates a **fresh** account each time, with its own Demo Team plan and users, so the result is the same whatever you did in free play. DocuCorp is not touched.

| Step | Action                                                         | Expected outcome                                         | Brief requirement it shows                                       |
| ---- | -------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| 1    | alice (Basic) processes 10                                     | accepted                                                 | A request within every limit is accepted                         |
| 2    | alice processes 25                                             | rejected: **user** `max_units_per_request` (Basic = 20)  | Per-request limit on the user's plan                             |
| 3    | bob (Premium) processes 45                                     | accepted; the account has 5 left                         | A bigger user plan; usage counts against the shared account      |
| 4    | carol (Basic) processes 10                                     | rejected: **account** `monthly_allowance`                | The account limit binds even when the user has plenty left       |
| 5    | `PATCH` Demo Team monthly → 200; `PUT` alice → Premium         | both 200                                                 | Limits change by configuration, with no code change or redeploy  |
| 6    | carol processes 10; alice processes 25                         | both accepted                                            | Changes apply to the next request; usage is kept across the plan switch |

Every step shows a one-line explanation, the decision (ACCEPTED / REJECTED, with the USER LIMIT / ACCOUNT LIMIT badge and a plain sentence for rejections), remaining for user and account, the expected outcome with a ✓ / ✗ mark, and the raw request/response JSON (collapsed).

Each scenario run leaves one small account (`Scenario <timestamp>`) in the database. There is no account deletion ([DESIGN.md §16](DESIGN.md#16-product-assumptions-to-copy-into-the-readme)), so this is expected.

### Reset

```sh
docker compose down -v   # removes the database and the demo-data volume, so DocuCorp starts fresh
docker compose up --build
```

Restarting without `-v` keeps DocuCorp, its usage and any configuration changes. If only the database volume is removed, the stored key no longer works: the demo logs a warning and creates a new DocuCorp.

### Smoke test

With the stack running:

```sh
cd demo-app
npm ci
npm run smoke   # DEMO_URL defaults to http://localhost:8080
```

It runs the guided scenario and checks all six outcomes from the raw API responses (not just the demo's own pass marks), processes and retries one document on DocuCorp to check for `replayed: true`, checks that an API error reaches the page as such, and checks that no response the page receives contains an `mk_` key. The smoke document asks for 1,000 units, more than any per-request limit allows, so it is rejected and uses no quota. CI runs the same check on a fresh `docker compose up --build --wait`.

To run the demo server outside Docker: `cd demo-app && ADMIN_API_KEY=… DATA_DIR=.data npm run dev` (it calls `METERING_API_URL`, default `http://localhost:3000`).

## Run the tests

Tests run against a real, separate Postgres (the `db-test` service in the `test` profile, on `localhost:5433`). Node 22+ is required.

```sh
docker compose --profile test up -d --wait db-test
cd api
npm ci
npm test
```

The suite migrates and seeds that database itself before the first test. Each test creates its own fresh account, so tests never share data and nothing needs cleaning up. To use a different database, set `TEST_DATABASE_URL`. The test suite ignores `DATABASE_URL` on purpose, so it can never run against the dev database.

Other scripts in `api/`: `npm run dev` (watch mode, reads `../.env`), `npm run build`, `npm start`, `npm run typecheck`.

## Load tests

k6 scenarios for throughput and correctness under contention ([DESIGN.md §11](DESIGN.md#11-performance-plan)). They need Docker with Compose v2, bash and curl; k6 and the setup script run in containers (compose profile `loadtest`).

```sh
load/run.sh hot-account baseline       # one scenario: fresh accounts → k6 → verify.sql → one-line summary
load/run-all.sh baseline 3             # every scenario 3 times, each on a fresh stack, then medians
```

`run.sh` starts `db` and `api` if needed, and with `FRESH_STACK=1` first runs `docker compose down -v`, which deletes the dev database and the demo's data. Results go to `load/results/<label>/`. After every run, `load/verify.sql` checks the counters against the ledger over the whole database and fails the run if anything is off. The baseline numbers, how long each scenario takes and the bottleneck analysis are in [docs/performance.md](docs/performance.md).
