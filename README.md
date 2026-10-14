# Usage Metering & Quota Service

An HTTP service that decides, before an application processes a unit of work, whether an account and one of its users still have quota for it. Each account and each user has a plan (a monthly allowance and a per-request limit). A consume call is accepted only if both levels pass, and every decision goes into a ledger. It is built with TypeScript, Express 5 and PostgreSQL 16, and correctness under concurrency is enforced by the database. See [DESIGN.md](DESIGN.md) for the full design. It is the source of truth for this project.

> Status: Phase 1 (skeleton). Only the health endpoints exist so far. See [DESIGN.md §18](DESIGN.md#18-build-order).

## Run it

Requires Docker with Compose v2.

```sh
docker compose up --build
curl localhost:3000/health/ready   # {"status":"ok"}
```

The API listens on `localhost:3000`. Optional settings (`ADMIN_API_KEY`, `LOG_LEVEL`, `DB_POOL_MAX`) can go in a `.env` file; see [.env.example](.env.example).

| Endpoint            | Meaning                                       |
| ------------------- | --------------------------------------------- |
| `GET /health/live`  | 200 while the process is up                   |
| `GET /health/ready` | 200 if the database answers `SELECT 1`, else 503 |

## Run the tests

Tests run against a real, separate Postgres (the `db-test` service in the `test` profile, on `localhost:5433`). Node 22+ is required.

```sh
docker compose --profile test up -d --wait db-test
cd api
npm ci
npm test
```

To use a different database, set `TEST_DATABASE_URL`. The test suite ignores `DATABASE_URL` on purpose, so it can never run against the dev database.

Other scripts in `api/`: `npm run dev` (watch mode, reads `../.env`), `npm run build`, `npm start`, `npm run typecheck`.
