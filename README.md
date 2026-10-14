# Usage Metering & Quota Service

An HTTP service that decides, before an application processes a unit of work, whether an account and one of its users still have quota for it. Each account and each user has a plan (a monthly allowance and a per-request limit). A consume call is accepted only if both levels pass, and every decision goes into a ledger. It is built with TypeScript, Express 5 and PostgreSQL 16, and correctness under concurrency is enforced by the database. See [DESIGN.md](DESIGN.md) for the full design. It is the source of truth for this project.

> Status: Phase 2a. Schema, predefined plans, accounts, API keys and auth exist so far. See [DESIGN.md §18](DESIGN.md#18-build-order).

## Run it

Requires Docker with Compose v2.

```sh
docker compose up --build
curl localhost:3000/health/ready   # {"status":"ok"}
```

The API listens on `localhost:3000`. On startup it applies database migrations and seeds the predefined plans. Both steps are safe to repeat on every start. Optional settings (`ADMIN_API_KEY`, `LOG_LEVEL`, `DB_POOL_MAX`) can go in a `.env` file; see [.env.example](.env.example).

| Endpoint                     | Auth          | Meaning                                                        |
| ---------------------------- | ------------- | -------------------------------------------------------------- |
| `GET /health/live`           | none          | 200 while the process is up                                    |
| `GET /health/ready`          | none          | 200 if the database answers and the latest migration is applied, else 503 |
| `POST /v1/admin/accounts`    | `X-Admin-Key` | Create an account `{ name, planId? }`; returns its first API key, once |
| `GET /v1/account`            | `X-API-Key`   | The caller's account and its current plan                      |
| `PUT /v1/account/plan`       | `X-API-Key`   | Switch to another predefined account plan `{ planId }`         |

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
```

Predefined plan ids (fixed, from [`api/src/db/seed.ts`](api/src/db/seed.ts)):

| Plan    | Scope   | Id                                     | Monthly | Max / request |
| ------- | ------- | -------------------------------------- | ------- | ------------- |
| Starter | account | `00000000-0000-4000-8000-00000000a001` | 10,000  | 100           |
| Pro     | account | `00000000-0000-4000-8000-00000000a002` | 100,000 | 500           |
| Basic   | user    | `00000000-0000-4000-8000-00000000b001` | 1,000   | 20            |
| Premium | user    | `00000000-0000-4000-8000-00000000b002` | 5,000   | 100           |

Errors are `application/problem+json` with a stable `code` (for example `MISSING_API_KEY`, `INVALID_API_KEY`, `VALIDATION_ERROR` with an `errors` list, `PLAN_NOT_FOUND`) and the `requestId`.

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
