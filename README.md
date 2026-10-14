# Usage Metering & Quota Service

An HTTP service that decides, before an application processes a unit of work, whether an account and one of its users still have quota for it. Each account and each user has a plan (a monthly allowance and a per-request limit). A consume call is accepted only if both levels pass, and every decision goes into a ledger. It is built with TypeScript, Express 5 and PostgreSQL 16, and correctness under concurrency is enforced by the database. See [DESIGN.md](DESIGN.md) for the full design. It is the source of truth for this project.

> Status: Phase 2b. Schema, predefined and custom plans, accounts, API keys and auth exist so far. See [DESIGN.md §18](DESIGN.md#18-build-order).

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
| `PUT /v1/account/plan`       | `X-API-Key`   | Switch to a predefined or own custom account plan `{ planId }` |
| `GET /v1/plans?scope=`       | `X-API-Key`   | Predefined plans + this account's custom plans                 |
| `POST /v1/plans`             | `X-API-Key`   | Create a custom plan `{ name, scope, rules: { monthlyAllowance?, maxUnitsPerRequest? } }` |
| `GET /v1/plans/:planId`      | `X-API-Key`   | One plan + how many of this account's account/users use it     |
| `PATCH /v1/plans/:planId`    | `X-API-Key`   | Change a custom plan's name/rules (`null` removes a rule); version +1 |

Plans are never deleted (see [DESIGN.md §16](DESIGN.md#16-product-assumptions-to-copy-into-the-readme)). New accounts can start only on a predefined plan. A missing rule means unlimited, and a limit of `0` blocks consumption.

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
```

Predefined plan ids (fixed, from [`api/src/db/seed.ts`](api/src/db/seed.ts)):

| Plan    | Scope   | Id                                     | Monthly | Max / request |
| ------- | ------- | -------------------------------------- | ------- | ------------- |
| Starter | account | `00000000-0000-4000-8000-00000000a001` | 10,000  | 100           |
| Pro     | account | `00000000-0000-4000-8000-00000000a002` | 100,000 | 500           |
| Basic   | user    | `00000000-0000-4000-8000-00000000b001` | 1,000   | 20            |
| Premium | user    | `00000000-0000-4000-8000-00000000b002` | 5,000   | 100           |

Errors are `application/problem+json` with a stable `code` and the `requestId`. The full list of codes is in [DESIGN.md §8.1](DESIGN.md#81-error-codes).

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
