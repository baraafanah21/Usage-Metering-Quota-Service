# Usage Metering & Quota Service — System Design

> Status: **Design, pre-implementation** · Stack: **TypeScript** (Node 22) + **Express 5** + **PostgreSQL 16** · One service, one database.
> This document is the source of truth for implementation. Every decision here should be defensible in the review.

---

## 0. TL;DR

- **One HTTP service** (Express 5 + `pg`, raw SQL, TypeScript) in front of **one PostgreSQL** database.
- The hot path is `POST /v1/consume`. It runs as **one short database transaction** that:
  1. checks the idempotency ledger,
  2. rejects per-request violations **without taking any lock**,
  3. locks the **account** monthly counter row, then the **user** monthly counter row (fixed order → no deadlocks),
  4. evaluates the rules with a **pure TypeScript function**,
  5. either increments both counters or neither, and appends one row to the **request ledger**,
  6. commits.
- **Correctness is enforced by the database**, not by the app: row locks serialize competing requests on the same counter, a `UNIQUE (account_id, request_id)` makes retries safe, `CHECK` constraints keep counters sane.
- **Invariant we test and check after every load test:**
  `counter.used == SUM(units) of accepted ledger rows` for every (account, month) and (user, month).
- Plans are **data**, read inside the consume transaction → changes apply to the next request, no redeploy, no cache to invalidate.
- Every decision stores a **snapshot of the limits it was evaluated against**, so history survives plan edits.

---

## 1. Context & Classification

| Item             | Answer                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Component type   | Synchronous **HTTP API** (command + queries), called server-to-server by the client application's backend.                                    |
| Callers          | (a) an **operator** (us) creating accounts with an admin key; (b) **account backends** using their API key. End users never call us directly. |
| Latency budget   | Consume is on the caller's critical path ("before processing a document"). Target **p99 < 50 ms** under normal load on a laptop.              |
| Consistency need | **Strong.** Over-granting quota is the main correctness bug. We prefer a slightly slower correct answer over a fast wrong one.                |
| Retry model      | Callers _will_ retry on timeouts → consume must be idempotent by `requestId`.                                                                 |
| Scale assumption | Single node. Many accounts, but realistic contention is "many users of one account" hitting the same account counter.                         |

---

## 2. Architecture

```mermaid
flowchart LR
    subgraph Docker Compose
        Demo["demo-app<br/>(Node + web page)<br/>holds account API key"]
        API["metering-api<br/>Express / TypeScript"]
        DB[(PostgreSQL 16)]
        K6["k6<br/>(profile: loadtest)"]
    end
    Browser((Browser)) -->|http :8080| Demo
    Demo -->|X-API-Key| API
    K6 -->|X-API-Key| API
    Operator((Operator / curl)) -->|X-Admin-Key| API
    API -->|pg pool| DB
```

Why the demo app has its own backend: the brief says the _application's backend_ calls us. Putting the API key in browser JavaScript would teach the wrong pattern. The demo server holds the key and exposes a tiny UI.

### 2.1 Layering inside the service

```
http (Express routers, auth middleware, zod validation, error middleware)
  └─> services (use-cases: consume, managePlans, manageUsers, queryUsage)
        ├─> domain/rules   ← pure functions, no I/O, 100% unit-testable
        └─> repositories   ← SQL only, one file per aggregate
              └─> db (pool, tx helper, migrations, seed)
```

Rules know nothing about HTTP or SQL. Repositories know nothing about rules. The consume service is the only place that orchestrates locking + evaluation + accounting.

### 2.2 Tech choices (boring by default)

| Concern            | Choice                                                                                                             | Why                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language           | **TypeScript** (strict mode)                                                                                       | Types for the domain (rules, decisions, errors) catch mistakes before runtime and document the contracts between layers.                                                                                                                                                                                                                                       |
| HTTP               | **Express 5**                                                                                                      | The framework the team already knows well, so time goes into correctness instead of learning a new tool. Express 5 forwards rejected promises from async handlers to the error middleware, so no `try/catch` per route. Framework speed is not the bottleneck: consume time is dominated by the account-row lock in Postgres (§11), which the load test shows. |
| Validation / types | **zod**                                                                                                            | One schema → runtime validation + inferred TS types (`z.infer`). Used in a small `validate(schema)` middleware.                                                                                                                                                                                                                                                |
| DB access          | **`pg` + raw SQL**                                                                                                 | The brief says "TypeScript and SQL". Locking semantics must be explicit and visible; ORMs hide `FOR UPDATE` and round trips.                                                                                                                                                                                                                                   |
| Migrations         | Plain numbered `.sql` files + tiny runner with a `schema_migrations` table, run on startup under an advisory lock. | Zero magic; safe if two instances start.                                                                                                                                                                                                                                                                                                                       |
| Logs               | **pino** + **pino-http** (JSON)                                                                                    | Structured request logs as one Express middleware, fast.                                                                                                                                                                                                                                                                                                       |
| Metrics            | **prom-client** at `/metrics`                                                                                      | RED metrics + decision counters for load-test analysis.                                                                                                                                                                                                                                                                                                        |
| Tests              | **Vitest** + **supertest** against a real Postgres (compose `db-test` service)                                     | supertest calls the Express app in-process, no running server needed. Concurrency bugs only show up against a real database; mocks would prove nothing.                                                                                                                                                                                                        |
| Load test          | **k6** (container, compose profile)                                                                                | Scriptable scenarios, thresholds, JSON summary committed to repo.                                                                                                                                                                                                                                                                                              |

---

## 3. Domain Model

| Concept                    | Notes                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Account**                | Tenant. Has exactly one _account-scope_ plan. Owns API keys, users, custom plans.                                                                    |
| **User**                   | Belongs to one account. Identified by the caller's own id (`externalId`, e.g. `"alice"`). Has exactly one _user-scope_ plan.                         |
| **Plan**                   | Named set of rules with a **scope** (`account` or `user`). Either _predefined_ (global, read-only) or _custom_ (owned by one account).               |
| **Rule**                   | `{ type, limit }`. Required types: `monthly_allowance`, `max_units_per_request`. A plan may omit a rule → that dimension is unlimited at that level. |
| **Usage counter**          | Units accepted for (account, month) and (user, month).                                                                                               |
| **Request (ledger entry)** | Immutable record of every decision, accepted or rejected, with the limits it was evaluated against.                                                  |

### 3.1 Effective limits

A consume request is evaluated against **two independent rule sets** — the account's plan and the user's plan. Both must pass. There is no "merging" of limits: each level is checked against its own counter. This directly implements "giving a user a larger allowance does not increase the account's shared allowance."

---

## 4. Database Schema

```mermaid
erDiagram
    accounts ||--o{ api_keys : has
    accounts ||--o{ users : has
    accounts ||--o{ plans : "owns (custom)"
    plans ||--o{ plan_rules : contains
    plans ||--o{ accounts : "assigned to"
    plans ||--o{ users : "assigned to"
    accounts ||--o{ account_monthly_usage : tracks
    users ||--o{ user_monthly_usage : tracks
    accounts ||--o{ usage_requests : logs
    users ||--o{ usage_requests : logs
```

```sql
-- Enums
CREATE TYPE plan_scope   AS ENUM ('account', 'user');
CREATE TYPE rule_type    AS ENUM ('monthly_allowance', 'max_units_per_request');
CREATE TYPE decision     AS ENUM ('accepted', 'rejected');

CREATE TABLE plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id uuid NULL,                           -- NULL = predefined; FK added after accounts (circular reference)
  scope            plan_scope NOT NULL,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  version          int  NOT NULL DEFAULT 1,             -- bumped on every rule change
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Name unique per owner+scope; predefined names unique among themselves.
CREATE UNIQUE INDEX plans_owner_scope_name ON plans (owner_account_id, scope, lower(name)) WHERE owner_account_id IS NOT NULL;
CREATE UNIQUE INDEX plans_predefined_name  ON plans (scope, lower(name)) WHERE owner_account_id IS NULL;

CREATE TABLE plan_rules (
  plan_id  uuid      NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  type     rule_type NOT NULL,
  "limit"  bigint    NOT NULL CHECK ("limit" >= 0),
  PRIMARY KEY (plan_id, type)                            -- at most one rule of each type per plan
);

CREATE TABLE accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  plan_id    uuid NOT NULL REFERENCES plans(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- plans ↔ accounts reference each other, so this FK is added once both tables exist.
ALTER TABLE plans ADD CONSTRAINT plans_owner_account_fk
  FOREIGN KEY (owner_account_id) REFERENCES accounts(id);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id),
  key_hash    bytea NOT NULL UNIQUE,     -- sha256(secret); plaintext never stored
  key_prefix  text  NOT NULL,            -- first chars, for display ("mk_7Fq2…")
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz NULL
);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  plan_id     uuid NOT NULL REFERENCES plans(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id),
  UNIQUE (id, account_id)                -- target for composite FKs below
);

CREATE TABLE account_monthly_usage (
  account_id uuid NOT NULL REFERENCES accounts(id),
  month      date NOT NULL CHECK (extract(day FROM month) = 1),
  used       bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (account_id, month)
);

CREATE TABLE user_monthly_usage (
  user_id    uuid NOT NULL,
  account_id uuid NOT NULL,
  month      date NOT NULL CHECK (extract(day FROM month) = 1),
  used       bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (user_id, month),
  FOREIGN KEY (user_id, account_id) REFERENCES users(id, account_id)  -- user can't leak across accounts
);
CREATE INDEX user_usage_by_account_month ON user_monthly_usage (account_id, month);

CREATE TABLE usage_requests (               -- append-only ledger
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id        uuid NOT NULL,
  user_id           uuid NOT NULL,
  request_id        text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  units             bigint NOT NULL CHECK (units > 0),
  decision          decision NOT NULL,
  reject_scope      plan_scope NULL,        -- 'account' | 'user' when rejected
  reject_rule       rule_type  NULL,
  month             date NOT NULL,
  account_plan_id   uuid NOT NULL, account_plan_version int NOT NULL,
  user_plan_id      uuid NOT NULL, user_plan_version    int NOT NULL,
  evaluation        jsonb NOT NULL,         -- snapshot: limits, used-before, remaining-after, all violations
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, request_id),          -- idempotency
  FOREIGN KEY (user_id, account_id) REFERENCES users(id, account_id),
  CHECK ((decision = 'accepted') = (reject_rule IS NULL AND reject_scope IS NULL))
);
CREATE INDEX usage_requests_account_hist ON usage_requests (account_id, id DESC);
CREATE INDEX usage_requests_user_hist    ON usage_requests (user_id, id DESC);
CREATE INDEX usage_requests_account_month ON usage_requests (account_id, month, id DESC);
```

### 4.1 Why this shape

| Decision                                                                         | Reason                                                                                                                                           | Rejected alternative                                                                                                                    |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Counter tables + ledger** (both)                                               | Counters give O(1) reads/locks on the hot path; the ledger gives history, auditability and a way to _verify_ counters.                           | Ledger only + `SUM()` per request → O(n) per consume, gets slower every month. Counters only → no history, no way to prove correctness. |
| **Rules as rows** (`plan_rules`)                                                 | Adding a rule type = add an enum value + one evaluator function. No schema change per plan. DB-checked limits.                                   | JSONB rules blob: flexible but no DB constraints; columns per rule: schema change per new rule type.                                    |
| `month` as `date` (first day)                                                    | Simple equality key, trivially indexable, easy to query "previous months".                                                                       | `timestamptz` ranges; `text 'YYYY-MM'`.                                                                                                 |
| Month computed **by Postgres** (`date_trunc('month', now() AT TIME ZONE 'UTC')`) | One clock for all instances; consistent with `created_at`. `now()` is the transaction start time → one transaction never spans two months.       | App clock: drift between instances.                                                                                                     |
| Composite FK `(user_id, account_id)`                                             | The database itself guarantees a user's usage/ledger rows can never be attributed to another account.                                            | Trust the app layer.                                                                                                                    |
| `api_keys.key_hash` = SHA-256                                                    | Keys are 32 random bytes → brute force is infeasible, so a slow KDF (bcrypt) buys nothing and costs ~100 ms per request. Lookup by unique index. | bcrypt (too slow on hot path); plaintext (leak = compromise).                                                                           |
| `plans.version` + snapshot in ledger                                             | "Changes must preserve past request history": each decision records exactly which plan version and limits produced it.                           | Plan history table only (more joins, same information).                                                                                 |
| Plans mutable in place (with version)                                            | Requirement: "updating a custom plan affects its assigned account/users".                                                                        | Immutable plans + reassign everyone (contradicts the requirement).                                                                      |

### 4.2 Invariants (and who enforces them)

| #   | Invariant                                                                                                                    | Enforced by                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| I1  | A user belongs to exactly one account; their usage/ledger rows carry that account                                            | Composite FKs                                                                       |
| I2  | `used >= 0`                                                                                                                  | `CHECK`                                                                             |
| I3  | Retry with the same `requestId` never double-counts                                                                          | `UNIQUE (account_id, request_id)` + same transaction as counter update              |
| I4  | Accepted ⇔ no reject reason                                                                                                  | `CHECK` on ledger                                                                   |
| I5  | Counter == Σ accepted ledger units, per (account,month) and (user,month)                                                     | Single transaction for both writes; verified by tests + post-load-test SQL          |
| I6  | Account `used` == Σ its users' `used` for the same month                                                                     | Both incremented in the same transaction; verified by tests                         |
| I7  | An account plan is `scope='account'`, a user plan is `scope='user'`; custom plans only assignable within their owner account | Service layer, inside the assigning transaction (a trigger is the hardening option) |
| I8  | Predefined plans are read-only                                                                                               | Service layer: `PATCH` on `owner_account_id IS NULL` → 403                          |
| I9  | Usage is never accepted beyond a monthly limit, even under concurrency                                                       | Row locks on counters (§6)                                                          |

---

## 5. Rules Engine

```ts
type RuleType = "monthly_allowance" | "max_units_per_request";
type Scope = "account" | "user";

interface RuleContext {
  units: number;
  usedThisMonth: number;
}
interface Violation {
  scope: Scope;
  rule: RuleType;
  limit: number;
  actual: number;
  message: string;
}

// Each rule is a pure function. Adding a rule type = add one entry here.
const evaluators: Record<
  RuleType,
  (limit: number, ctx: RuleContext) => boolean
> = {
  max_units_per_request: (limit, c) => c.units <= limit,
  monthly_allowance: (limit, c) => c.usedThisMonth + c.units <= limit,
};
```

**Evaluation order** (deterministic, documented, and why):

1. `user.max_units_per_request`
2. `account.max_units_per_request`
3. `user.monthly_allowance`
4. `account.monthly_allowance`

Stateless rules first (they don't need counters → can reject **before taking any lock**), and within each class _user_ before _account_ because the user rule is the more specific explanation. All violations are computed and returned in `violations[]`; the first one in this order is the `primary` reason. This matches the brief's three examples exactly.

**Remaining** at a level = `max(0, limit − used)` (or `null` = unlimited). Reducing a limit below usage shows `0` and rejects further consumption — no negative numbers, no special case.

### 5.1 Optional extra rule (stretch, only after the core is done)

`daily_allowance` — fits the same model: a counter keyed by day instead of month. It shows the engine is extensible and interacts with the plans the same way (every rule of both plans must pass). Decision: implement **only** after every core phase in §18 is done and tested; otherwise document it as a designed-but-not-built extension.

---

## 6. The Consume Path (the heart of the project)

### 6.1 Contract

```http
POST /v1/consume
X-API-Key: mk_...
Content-Type: application/json

{ "userId": "alice", "units": 10, "requestId": "doc-8f2a-processing" }
```

```jsonc
// 200 OK — accepted
{
  "requestId": "doc-8f2a-processing",
  "decision": "accepted",
  "units": 10,
  "month": "2026-10",
  "account": { "planId": "…", "planName": "Starter", "monthlyAllowance": 10000, "used": 4210, "remaining": 5790, "maxUnitsPerRequest": 100 },
  "user":    { "planId": "…", "planName": "Basic",   "monthlyAllowance": 1000,  "used": 310,  "remaining": 690,  "maxUnitsPerRequest": 20 },
  "replayed": false
}

// 200 OK — rejected (a rejection is a business outcome, not an HTTP error)
{
  "requestId": "doc-9c11",
  "decision": "rejected",
  "reason": { "scope": "account", "rule": "monthly_allowance", "limit": 10000, "message": "Account monthly allowance exceeded: 9995 used + 10 requested > 10000" },
  "violations": [ /* all failing rules, same shape */ ],
  "account": { …, "remaining": 5 },
  "user":    { …, "remaining": 690 },
  "replayed": false
}
```

**Why 200 for rejections:** the request was processed and recorded successfully; the _decision_ is data. It keeps retry logic trivial for callers (4xx/5xx = "something is wrong with the call", 200 = "here is your answer"), and a stored rejection is replayable like an acceptance. `429` was considered and rejected: it implies "retry later", which is wrong for a per-request-limit rejection.

### 6.2 Sequence

```mermaid
sequenceDiagram
    participant C as Caller backend
    participant A as API
    participant P as Postgres
    C->>A: POST /v1/consume (X-API-Key, userId, units, requestId)
    A->>A: validate body, resolve key → accountId (LRU cache, 30s TTL)
    A->>P: BEGIN
    A->>P: SELECT ledger WHERE account_id, request_id
    alt already exists
        A->>P: COMMIT
        A-->>C: stored decision (replayed: true) or 409 if payload differs
    end
    A->>P: SELECT user + user plan rules + account plan rules (1 query)
    alt user not in this account
        A-->>C: 404 USER_NOT_FOUND (nothing recorded)
    end
    A->>A: evaluate stateless rules (max per request)
    alt violated
        A->>P: INSERT ledger (rejected)
        A->>P: COMMIT
        A-->>C: 200 rejected
    end
    A->>P: upsert+lock account counter row (FOR UPDATE)
    A->>P: upsert+lock user counter row (FOR UPDATE)
    A->>A: evaluate monthly rules
    alt accepted
        A->>P: UPDATE both counters (+units)
    end
    A->>P: INSERT ledger row
    A->>P: COMMIT
    A-->>C: 200 decision
```

### 6.3 Locking — why it's correct

- **Isolation level: `READ COMMITTED`** + explicit row locks. Every check that matters (monthly allowance) reads a counter row **after locking it**, so it sees the latest committed value. Two concurrent requests for the same account serialize on the account row; the second one sees the first one's increment. This is exactly the race the brief is testing.
- **Lock acquisition** in one statement, which also creates the row on first use of the month:
  ```sql
  INSERT INTO account_monthly_usage (account_id, month, used) VALUES ($1, $2, 0)
  ON CONFLICT (account_id, month) DO UPDATE SET used = account_monthly_usage.used
  RETURNING used;      -- row is now locked until COMMIT
  ```
- **Fixed lock order: account row, then user row.** Every transaction follows it → no deadlock cycles possible.
- **Rejections on per-request limits take no counter locks** → a misbehaving client spamming oversized requests can't slow down everyone else on the account.
- **Rejections on monthly limits** do take the locks briefly (they had to read the counter), but write nothing to counters.
- **Why not `SERIALIZABLE`?** It would also be correct, but under contention it aborts transactions (serialization failures) that we'd have to retry in a loop, wasting work exactly when load is highest. Pessimistic row locks give the same guarantee with queueing instead of retry storms.
- **Why not a conditional `UPDATE … WHERE used + $u <= limit` without a lock?** It's correct for one level, but we need _both_ levels to pass atomically _and_ to explain which rule failed. With two conditional updates we'd have to roll back the first when the second fails — the transaction does that, so it's an optimization of the same design, kept for the performance phase (§11).

### 6.4 Idempotency (retries)

| Situation                                                                     | Behaviour                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Same `requestId`, same `userId` + `units`                                     | Return the **originally stored decision** (accepted _or_ rejected), `replayed: true`, header `Idempotent-Replayed: true`. Counters untouched.                                                                                                          |
| Same `requestId`, different payload                                           | `409 IDEMPOTENCY_CONFLICT`. Nothing changes.                                                                                                                                                                                                           |
| Two identical requests **in flight at the same time**                         | Both may pass the initial SELECT. The second `INSERT` hits the unique constraint (`23505`) → its whole transaction rolls back (including its counter increment) → service re-reads the winner's row and returns it as a replay. Exactly one increment. |
| Validation error (400), auth error (401), unknown user (404)                  | **Not recorded**; the `requestId` is not consumed, so the caller can fix and resend with the same id.                                                                                                                                                  |
| A rejected request retried later with the same id after the plan was upgraded | Still returns the stored rejection — a `requestId` names _one decision_, forever. To try again, send a new id. Documented in README.                                                                                                                   |
| Scope of uniqueness                                                           | Per account (`UNIQUE (account_id, request_id)`), so two tenants can't collide or probe each other's ids.                                                                                                                                               |
| Retention                                                                     | Forever (ledger is also the history). Fine for the project; a real system would partition by month.                                                                                                                                                    |

### 6.5 Plan changes vs in-flight requests

Plans and assignments are read **inside** the consume transaction, with no cache. Therefore:

- A request whose transaction starts after a plan update commits **always** sees the new rules. → "Changes apply to new requests after the update succeeds."
- A request already in flight when the update commits may finish with the old rules. That request logically happened _before_ the update; its ledger row records the old `plan_version`, so this is visible, not silent.
- Switching plan does **not** touch counters → consumed units are preserved; no fresh allowance.
- Considered and rejected: `FOR SHARE` lock on plan rows to strictly order updates against consumes — it would make every consume of a popular plan contend on one row (multixact overhead) to close a window of a few milliseconds that has no business impact.

---

## 7. Authentication, Authorization, Isolation

| Principal    | Credential                               | Can do                                                            |
| ------------ | ---------------------------------------- | ----------------------------------------------------------------- |
| **Operator** | `X-Admin-Key` (from env `ADMIN_API_KEY`) | Create accounts (receives the account's first API key).           |
| **Account**  | `X-API-Key: mk_<base62 32 bytes>`        | Everything about _its own_ account, plans, users, usage, history. |

- **API key lifecycle:** generated with `crypto.randomBytes(32)`; shown **once** in the creation response; only `sha256` stored. Optional rotation: `POST /v1/account/api-keys` (new key) and `DELETE /v1/account/api-keys/:id` (revoke). Revoked keys fail immediately (cache entry removed on revoke; 30s TTL bounds staleness for multiple instances — documented).
- **Enforcement point:** an Express `requireApiKey` middleware, mounted on the `/v1` router before every account route, resolves the key → `req.accountId` (typed through a `Request` declaration merge). A separate `requireAdminKey` middleware guards `/v1/admin`. Missing → `401 MISSING_API_KEY`; unknown/revoked → `401 INVALID_API_KEY` (same response timing; no hint which).
- **Tenant scoping rule:** the account id **never comes from the URL or body**. Every repository function takes `accountId` as its first parameter and every query has `WHERE account_id = $1`. Users are addressed by `externalId`, resolved as `WHERE account_id = $1 AND external_id = $2`.
- **Cross-tenant access returns 404, not 403** — an account can't even learn that another account's user or plan exists.
- **Plans:** predefined visible to all, writable by nobody; custom visible and writable only by owner; assignment checks scope + ownership.
- **Mandatory tests:** missing key, garbage key, revoked key, account A reading/consuming/assigning on account B's user and plan → all rejected and nothing changes.

---

## 8. HTTP API

All routes under `/v1`, JSON, errors as `application/problem+json`:

```json
{
  "type": "about:blank",
  "title": "User not found",
  "status": 404,
  "code": "USER_NOT_FOUND",
  "detail": "No user 'bob' in this account",
  "requestId": "<trace id>"
}
```

| Method & path                                         | Auth  | Purpose                                                                             |
| ----------------------------------------------------- | ----- | ----------------------------------------------------------------------------------- |
| `POST /v1/admin/accounts`                             | admin | Create account `{name, planId?}` → `{account, apiKey}` (default plan: Starter)      |
| `GET /v1/account`                                     | key   | Account info + current plan + current-month usage                                   |
| `PUT /v1/account/plan`                                | key   | Assign account plan `{planId}`                                                      |
| `POST /v1/account/api-keys` / `DELETE …/:id`          | key   | Rotate keys (optional)                                                              |
| `GET /v1/plans?scope=`                                | key   | Predefined + own custom plans                                                       |
| `POST /v1/plans`                                      | key   | Create custom plan `{name, scope, rules: {monthlyAllowance?, maxUnitsPerRequest?}}` |
| `GET /v1/plans/:planId`                               | key   | Plan + rules + version + how many users/accounts use it                             |
| `PATCH /v1/plans/:planId`                             | key   | Update name/rules of a custom plan → version+1. `null` removes a rule.              |
| `POST /v1/users`                                      | key   | Register `{externalId, planId?}` (default plan: Basic). 409 if exists.              |
| `GET /v1/users?limit&cursor`                          | key   | List users (keyset pagination)                                                      |
| `GET /v1/users/:externalId`                           | key   | User + plan                                                                         |
| `PUT /v1/users/:externalId/plan`                      | key   | Assign user plan `{planId}`                                                         |
| `GET /v1/users/:externalId/limits`                    | key   | **Effective limits now:** account plan + user plan + remaining at both levels       |
| `POST /v1/consume`                                    | key   | The decision (§6)                                                                   |
| `GET /v1/usage?month=YYYY-MM`                         | key   | Account used/remaining + per-user breakdown (paginated)                             |
| `GET /v1/users/:externalId/usage?month=`              | key   | User used/remaining for a month                                                     |
| `GET /v1/requests?userId&month&decision&limit&cursor` | key   | History of decisions, newest first, keyset pagination on `id`                       |
| `GET /health/live`, `/health/ready`, `/metrics`       | none  | Probes and Prometheus metrics                                                       |

**Pagination:** keyset (`WHERE id < $cursor ORDER BY id DESC LIMIT $n+1`), opaque base64 cursor, `limit` ≤ 100. Offset pagination was rejected because it gets slower as history grows and skips/duplicates rows when new requests arrive during paging.

**Past months:** `remaining` for a past month is computed against the plan **currently** assigned (documented); the exact limits applied at the time are in each ledger row's `evaluation` snapshot.

---

## 9. Predefined Plans (seeded idempotently on startup)

| Scope   | Plan        | Monthly allowance | Max units / request | Reasoning                                 |
| ------- | ----------- | ----------------- | ------------------- | ----------------------------------------- |
| account | **Starter** | 10,000            | 100                 | Matches the brief's example.              |
| account | **Pro**     | 100,000           | 500                 | 10× capacity for larger teams.            |
| user    | **Basic**   | 1,000             | 20                  | Matches the brief's example.              |
| user    | **Premium** | 5,000             | 100                 | Power user; still bounded by the account. |

Seeding uses fixed UUIDs + `INSERT … ON CONFLICT DO NOTHING`, so restarts are safe and the demo can refer to plans by id.

---

## 10. Failure Modes

| Failure                                                                   | Behaviour                                                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Postgres down at startup                                                  | Migration runner retries with backoff; `/health/ready` = 503 until connected; compose `depends_on: condition: service_healthy`. |
| Postgres down mid-request                                                 | `503 SERVICE_UNAVAILABLE`, transaction never committed → nothing recorded; caller retries with same `requestId` (safe).         |
| Client timeout after we committed                                         | Caller retries with same `requestId` → gets the stored decision. **This is why idempotency exists.**                            |
| Lock wait too long under extreme contention                               | `SET LOCAL lock_timeout = '2s'` and `statement_timeout = '5s'` → `503 BUSY`, nothing committed, retry is safe.                  |
| Deadlock                                                                  | Prevented by fixed lock order; if Postgres still reports `40P01`, the tx is retried once internally (it committed nothing).     |
| Pool exhaustion                                                           | Bounded pool (`max` ≈ 20); Node `server.requestTimeout`; shows up in metrics as queue time.                                     |
| Invalid input (units 0, negative, float, > 1,000,000,000, missing fields) | `400 VALIDATION_ERROR` with field details, not recorded.                                                                        |
| Unknown user                                                              | `404 USER_NOT_FOUND`, not recorded (caller must register users explicitly — see assumptions).                                   |
| Month rollover during load                                                | `now()` is fixed per transaction → each request lands in exactly one month; new month's counter row is created by the upsert.   |
| Graceful shutdown (SIGTERM)                                               | Stop accepting, finish in-flight requests, close pool.                                                                          |

---

## 11. Performance Plan

### 11.1 Expected bottleneck

The **account counter row**. All consumes for one account serialize on it, so per-account throughput ≈ `1 / (time the lock is held)`. Throughput across _different_ accounts scales with CPU/connections. Everything we optimize is "hold the lock for less time / fewer round trips while holding it".

### 11.2 Scenarios (k6, committed in `load/`)

| Scenario      | Shape                                                 | What it proves                                                  |
| ------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| `spread`      | 200 accounts × 5 users, random consumes               | Baseline throughput with no contention                          |
| `hot-account` | 1 account, 500 users, 100 VUs                         | Contention on the shared row; latency vs concurrency            |
| `hot-user`    | 1 user, 100 VUs                                       | Worst case (both rows hot)                                      |
| `exhaust`     | Allowance 10,000, 20,000 units requested concurrently | **Correctness under load:** exactly 10,000 accepted, never more |
| `retry-storm` | Same `requestId` sent ×N concurrently                 | Exactly one increment                                           |
| `plan-flip`   | Consumes while another VU toggles the user plan       | No errors, every ledger row consistent with its plan version    |

After every run a **verification script** (`load/verify.sql`) checks invariants I5 and I6 over the whole database and fails loudly if they don't hold. Performance numbers without this check don't count.

### 11.3 Iterations (measure → change one thing → re-measure → record in `docs/performance.md`)

1. **Baseline:** straightforward multi-statement transaction (~6 round trips).
2. **API-key cache:** in-process LRU (30s TTL) → removes 1 query per request.
3. **Fewer round trips:** user + both plans' rules in one query; counter upsert+lock merged (`INSERT … ON CONFLICT DO UPDATE … RETURNING`).
4. **Stateless pre-check before locks** (already in design; measure the gain on the oversized-request mix).
5. **Single round trip:** move the locked section into one SQL statement (data-modifying CTE) or a PL/pgSQL function → the lock is held for ~one network round trip less. Compare honestly; keep it only if the gain justifies moving logic into SQL.
6. **Pool size tuning:** sweep `max` (5/10/20/50) and show where more connections stop helping (contention, not connections, is the limit).

Results table per iteration: RPS, p50/p95/p99, error rate, invariant check ✅/❌, plus a short "what we learned".

### 11.4 Known scaling limits (for the README)

- One hot account is bounded by single-row lock throughput (thousands/s, not millions). The real-world fix is **pre-allocating quota slices** to users/instances or sharded counters — out of scope and explained, not built.
- Ledger grows forever → monthly partitioning of `usage_requests` is the next step.

---

## 12. Observability

- **Logs (pino, JSON):** one line per request: `reqId`, `accountId`, route, status, latency. Consume adds `decision`, `rejectScope`, `rejectRule`, `replayed`. API keys are redacted.
- **Metrics:** `http_request_duration_seconds{route,status}`, `consume_decisions_total{decision,scope,rule}`, `consume_replays_total`, `consume_idempotency_conflicts_total`, `db_pool_waiting`, `db_tx_duration_seconds`.
- **Health:** `/health/live` (process up), `/health/ready` (`SELECT 1` succeeds + migrations applied).
- Every response carries `X-Request-Id` (incoming or generated) for tracing a request through logs — useful in the live debugging part of the review.

---

## 13. Testing Strategy

| Layer                       | What                                                                                                                                                                                                                                                                                                                                                | Tool                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Unit                        | Rules engine: every brief example (25 → user per-request; 10 → accepted; account has 5 left → account monthly), order of violations, `remaining` clamps at 0, missing rule = unlimited                                                                                                                                                              | Vitest, pure functions                 |
| Integration (real Postgres) | Every endpoint happy path + errors; **auth:** missing/invalid/revoked key; **isolation:** A cannot see/consume/assign B's users and plans; plan update affects all assigned users; plan switch preserves usage; allowance lowered below usage → remaining 0 + rejections; month boundary (by inserting a past-month counter/ledger and querying it) | Vitest + supertest                     |
| Concurrency                 | 200 parallel consumes vs allowance → exact accept count; account = Σ users; 50 parallel identical `requestId` → 1 row, 1 increment; payload mismatch → 409                                                                                                                                                                                          | Vitest + `Promise.all` against real DB |
| Load                        | §11                                                                                                                                                                                                                                                                                                                                                 | k6                                     |
| Demo smoke                  | Demo scenario runs end-to-end in compose                                                                                                                                                                                                                                                                                                            | script                                 |

Each test file uses a fresh account (new UUIDs), so tests can run in parallel without truncating tables.

---

## 14. Demo Application

`demo-app` (small Node server + one HTML page, port 8080):

- On startup: waits for the API, then **idempotently** creates the "DocuCorp" account via the admin key and stores its API key in a volume, creates a custom account plan _Demo Team_ (monthly 60, max/request 50) and three users: **alice (Basic)**, **bob (Premium)**, **carol (Basic)**.
- UI: one card per user — plan, used/remaining for user **and** shared account, "Process document (N units)" button, last decision with the reason highlighted (user vs account).
- **Guided scenario button** that walks through the brief's required story, step by step:
  1. alice processes 10 → ✅ accepted
  2. alice processes 25 → ❌ rejected by **user** `max_units_per_request` (Basic = 20)
  3. bob (Premium) processes 45 → ✅ ; account now has 5 left
  4. carol processes 10 → ❌ rejected by **account** `monthly_allowance` (carol herself has plenty)
  5. **Change configuration only** (no client code change): `PATCH` the account plan to monthly 200, and `PUT` alice → Premium
  6. carol 10 → ✅ ; alice 25 → ✅ — same client code, different outcome.
- Each step shows the raw request/response JSON, so the reviewer sees the API, not just a pretty UI.

---

## 15. Repository Layout

```
.
├── docker-compose.yml          # db, api, demo; profiles: test (db-test), loadtest (k6)
├── README.md                   # setup, API examples, assumptions, decisions, limitations
├── DESIGN.md                   # this document
├── api/
│   ├── Dockerfile
│   ├── src/
│   │   ├── server.ts / app.ts / config.ts
│   │   ├── http/{middleware/{auth.ts, validate.ts, errors.ts}, routes/*.ts, schemas/*.ts}
│   │   ├── services/{consume.ts, plans.ts, users.ts, usage.ts, accounts.ts}
│   │   ├── domain/{rules.ts, month.ts, errors.ts}
│   │   ├── repositories/{plans.ts, users.ts, usage.ts, requests.ts, accounts.ts, apiKeys.ts}
│   │   └── db/{pool.ts, tx.ts, migrate.ts, seed.ts, migrations/001_init.sql}
│   └── test/{unit, integration, concurrency}
├── demo-app/{Dockerfile, server.ts, public/index.html}
├── load/{scenarios/*.js, verify.sql, run.sh, results/}
└── docs/{performance.md, api-examples.http}
```

---

## 16. Product Assumptions (to copy into the README)

1. **Accounts are created by an operator** using `ADMIN_API_KEY`; there is no public signup (out of scope: end-user login).
2. **Users must be registered** before consuming; consuming for an unknown user → 404. (Auto-registration would silently create users from typos.)
3. **Default plans:** new account → Starter, new user → Basic, unless specified.
4. **A missing rule means unlimited** at that level. A limit of `0` is valid and blocks consumption.
5. **Units:** positive integers, max 1,000,000,000 per request (input-sanity bound, separate from plan rules).
6. **`requestId`** is unique per account, 1–200 chars, and identifies one decision forever (including rejections).
7. **Rejected requests** are recorded in history but consume nothing.
8. **No partial acceptance.**
9. **Month** = UTC calendar month of the database transaction time.
10. **Allowance reduced below usage** → remaining 0, further requests rejected at that level until the next month or an increase.
11. **Plan switch mid-month** keeps consumed units; the new plan's limits are compared against the same counter.
12. **Predefined plans are read-only** and visible to everyone; custom plans are private to their account.
13. **Plans cannot be deleted** while assigned (`409 PLAN_IN_USE`); deleting unused custom plans is optional.
14. **Users are not deleted** (history must be preserved); out of scope.
15. **Past-month remaining** is reported against the currently assigned plan; the historically applied limits are in each ledger entry.

---

## 17. Known Limitations (honest list for the review)

- Per-account throughput is capped by a single hot row (§11.4).
- API-key cache can serve a revoked key for up to 30 s on _other_ instances (single instance here: revocation is immediate).
- Requests in flight during a plan update may use the previous version (§6.5) — recorded, not hidden.
- Ledger is unpartitioned; idempotency keys are kept forever.
- No rate limiting of the API itself (different from quota), no RBAC, no billing.

---

## 18. Build Order

Phases run in this order; each one is finished when its check passes.

| Phase | Deliverable                                                                        | Done when                                                  |
| ----- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1     | Repo skeleton (TypeScript strict, Express 5 app, `pg` pool), compose with db + api | `docker compose up --build` shows `/health/ready` 200      |
| 2     | Migrations, seed, accounts + API keys + auth middleware, plans CRUD                | Auth + isolation tests green                               |
| 3     | Users, rules engine (unit tests), **consume** v1                                   | Brief's 3 examples pass as integration tests               |
| 4     | Idempotency + concurrency tests, usage & history endpoints with pagination         | Concurrency suite green 20× in a row                       |
| 5     | Demo app + guided scenario in compose                                              | Fresh clone → `docker compose up --build` → scenario works |
| 6     | k6 scenarios, verify.sql, baseline numbers, optimizations §11.3                    | `docs/performance.md` with before/after table              |
| 7     | README (API examples, assumptions, decisions, limitations), error polish           | Someone else could run everything from README alone        |
| 8     | Optional `daily_allowance` rule                                                    | Only if phases 1–7 are done                                |
| 9     | Final clean-clone run, rehearse tracing a consume request through the code         | Can explain every line of `services/consume.ts`            |

**Rule:** the core (consume correctness + idempotency + isolation + compose) is finished and tested before _anything_ optional is touched.
