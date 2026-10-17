# Performance

Load testing for the consume path (DESIGN.md §11): how to reproduce the numbers, the Phase 6a baseline, where the time goes, and what Phase 6b is expected to change. Every number here comes from a run whose `load/verify.sql` passed. Numbers without that check don't count.

## Reproduce

**Prerequisites:** Docker with Compose v2, bash and curl. k6 (`grafana/k6:2.3.0`) and the Node scripts (`node:22.23.3-bookworm-slim`) run in containers under the compose profile `loadtest`, so nothing else is installed on the host. Port 3000 must be free, because the host scrapes `/metrics` there.

```sh
load/run.sh <scenario> <label>              # one scenario on the running stack (started if needed)
FRESH_STACK=1 load/run.sh <scenario> <label>  # same, after `docker compose down -v` (empty database)
load/run-all.sh baseline 3                  # every scenario 3×, each on a fresh stack, then medians
```

`FRESH_STACK=1` and `run-all.sh` delete the dev database and the demo's volume. They also remove the compose network, so a running `db-test` (profile `test`) loses its network. Afterwards, bring it back with `docker compose --profile test up -d --wait --force-recreate db-test`. During the baseline, `db-test` was stopped, so it took no CPU.

What `run.sh` does, in order:

1. `docker compose up -d --build --wait db api` and `CREATE EXTENSION IF NOT EXISTS pg_stat_statements` (the compose `db` preloads it).
2. **Setup** (`load/setup.ts`, container `load-setup`): creates the scenario's accounts with the admin key, then their plans and users with each account's own key, all through the public API. Keys and ids go to `load/.work/<scenario>.json` (gitignored, mode 600). Every run uses fresh accounts.
3. Resets `pg_stat_statements`, scrapes `/metrics` and the db/api containers' cgroup CPU counters, and starts sampling the pool gauges every 0.5 s.
4. **k6** (`load/scenarios/<scenario>.js`) against `http://api:3000` on the compose network. The summary goes to `load/results/<label>/<scenario>.json`, the console output to `<scenario>.k6.txt`.
5. Scrapes `/metrics` and the CPU counters again. Saves the top 15 statements by total time to `<scenario>.pgss.txt`.
6. **`load/verify.sql`** over the whole database, plus exact expectations for `exhaust` and `retry-storm` → `<scenario>.verify.txt`.
7. `load/report.ts` turns the snapshots into `<scenario>.metrics.json` and prints one line.

`run.sh` exits non-zero if a k6 threshold or `verify.sql` fails.

| Scenario      | Shape                                                                      | k6 thresholds (besides < 1 % errors, p99 < 2 s, checks > 99 %) | Wall time per run\* |
| ------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------: |
| `spread`      | 200 accounts × 5 users, 1–10 units, 100 VUs, 60 s                          | –                                                                | ≈ 77 s |
| `hot-account` | 1 account, 500 users, 1–10 units, 100 VUs, 60 s                            | –                                                                | ≈ 76 s |
| `hot-user`    | 1 account, 1 user, 1–10 units, 100 VUs, 60 s                               | –                                                                | ≈ 75 s |
| `exhaust`     | allowance 10,000; 2,000 requests × 10 units over 100 VUs and 50 users      | exactly 1,000 accepted and 1,000 rejected                        | ≈ 22 s |
| `retry-storm` | 100 fixed requests (10 users, 1–5 units), resent by 100 VUs for 30 s       | –                                                                | ≈ 45 s |
| `plan-flip`   | 50 VUs consume 1–30 units for 60 s; 1 VU PATCHes the users' plan max 10 ↔ 30 then sleeps 100 ms | ≥ 100 flips, < 1 % failed flips                  | ≈ 75 s |

\* With `FRESH_STACK=1`, including stack start and setup. `run-all.sh baseline 3` took 18.5 minutes (20:59–21:18) in all.

All scenarios are closed-loop: each VU sends its next request as soon as the previous one is answered, with no think time. They measure throughput at saturation, and latency includes every queue on the way. The error rate is every non-200 response. A rejection is a 200 (§6.1), so the only expected business outcomes are already 200s.

## Machine

All numbers below come from one laptop. **k6, the API and Postgres all run on it at once**, so they compete for the same CPUs, and k6's own CPU use is part of the picture. Compare the numbers with each other and with Phase 6b runs on the same machine, not with other hardware.

| | |
| --- | --- |
| CPU | 12th Gen Intel Core i7-12650H: 10 cores (6 performance + 4 efficient), 16 threads, up to 4.7 GHz |
| RAM | 15 GiB (about 5 GiB free while the runs ran; the desktop and the IDE were open) |
| OS | Ubuntu 24.04.4 LTS, kernel 7.0.0-38-generic; on AC power, `powersave` CPU governor, `balanced` platform profile |
| Docker | Engine 29.6.1 running natively (no VM), Compose v5.2.0, cgroup v2. **No CPU or memory limits** on any container: Docker sees all 16 CPUs and 15.24 GiB |
| Stack | `postgres:16` (default config plus `pg_stat_statements`), API with `DB_POOL_MAX=20` and `LOG_LEVEL=info` (one JSON log line per request, as in production), `grafana/k6:2.3.0` |

## Baseline (Phase 6a)

`load/run-all.sh baseline 3` on 2026-10-16: every scenario 3 times, each run on a fresh stack (`docker compose down -v`, so every run starts from an empty database). The table shows the **median of the 3 runs** for each column, taken per column (so one row's numbers can come from different runs). Latencies are from k6 (client side), for consume requests only. The pool, transaction and CPU columns come from the API's `/metrics` and the containers' cgroups during the run.

| Scenario | Req/s | p50 ms | p95 ms | p99 ms | Error rate | `db_pool_waiting` (avg) | `consume_tx_duration` mean ms | `consume_pool_acquire` mean ms | CPU cores db / api | verify.sql |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | :-: |
| spread | 1,841 | 52.2 | 69.5 | 80.0 | 0.00 % | 76.9 | 9.94 | 20.78 | 3.18 / 1.10 | ✅ 3/3 |
| hot-account | 322 | 286.1 | 462.0 | 582.9 | 0.00 % | 78.6 | 61.89 | 122.53 | 0.82 / 0.43 | ✅ 3/3 |
| hot-user | 296 | 314.8 | 507.1 | 638.8 | 0.00 % | 78.5 | 67.21 | 132.79 | 0.84 / 0.45 | ✅ 3/3 |
| exhaust | 306 | 297.1 | 482.0 | 606.3 | 0.00 % | 65.9 | 64.35 | 125.68 | 0.72 / 0.50 | ✅ 3/3 |
| retry-storm | 3,120 | 30.6 | 39.0 | 48.5 | 0.00 % | 73.5 | 5.13 | 11.77 | 1.29 / 1.15 | ✅ 3/3 |
| plan-flip | 483 | 79.6 | 261.0 | 383.2 | 0.00 % | 29.8 | 41.04 | 29.93 | 1.05 / 0.53 | ✅ 3/3 |

Spread between runs: spread 1,778–1,929 req/s, hot-account 285–326, hot-user 264–300, exhaust 274–310, retry-storm 3,009–3,248, plan-flip 470–493. Run 3 was the slowest for every lock-bound scenario (by about 10 %). That is laptop noise (the runs share the machine with the desktop), which is why the table uses medians.

**Correctness, all 18 runs:** `verify.sql` passed every time (I5, I6, allowance, snapshots, over the whole database). Zero non-200 responses.

- **exhaust:** exactly **10,000 units accepted in 1,000 requests**, 1,000 rejected by the account's `monthly_allowance`, 2,000 ledger rows, in all 3 runs. This was checked by both the k6 thresholds and `verify.sql`.
- **retry-storm:** exactly **one ledger row per `requestId`** (100 rows, 300 units, matching the 100 fixed requests) in all 3 runs, while 90,226–97,403 other answers were replays. In run 2, 18 requests lost the race on the ledger's unique key and were answered with the winner's decision (`pg_stat_statements`: 93,663 `BEGIN`s, 93,645 `COMMIT`s, 18 extra ledger reads).
- **plan-flip:** the flipper changed the plan 330–338 times per run (about every 180 ms: 100 ms of sleep plus the PATCH under load). 16,356–17,002 consumes were accepted and 11,939–12,603 were rejected by `max_units_per_request`, and every accepted row fits the limits of the plan version in its own snapshot.

**Mutation check of the harness:** with the row lock on the account counter replaced by a plain read (`ON CONFLICT DO NOTHING` + `SELECT`), `exhaust` accepted 1,019 requests (10,190 units against an allowance of 10,000). `verify.sql` failed with `ALLOWANCE FAILED: … used 10190 > allowance 10000`, the k6 thresholds `consume_accepted count==1000` / `consume_rejected count==1000` failed, and `run.sh` exited 1. With the lock restored, the run passed. Each `verify.sql` check was also shown to fail on corrupted data inside a rolled-back transaction: a counter +1 (I5); a user counter +1 with the I5 blocks removed (I6, which can't break while I5 holds, because the ledger's foreign key ties each row to its user's account); a snapshot limit lowered and a plan version changed (snapshot); a wrong expectation (exact units/rows).

**Raw results:** [`load/results/baseline/`](../load/results/baseline/) has `run1`–`run3`, with five files per scenario: `<scenario>.json` (k6 summary export), `.k6.txt` (k6 console output), `.metrics.json` (`/metrics` deltas, pool samples, CPU), `.pgss.txt` (top statements) and `.verify.txt`. It also has `summary.md` and `summary.json` (medians plus every run's numbers). [`load/results/evidence-eventloop/`](../load/results/evidence-eventloop/) is one extra spread run with event-loop lag sampled every second (see below).

## Where the time goes

### One request's path

Every consume makes **10 sequential round trips** to Postgres (counted in Phase 3b). The first is the API-key lookup (`pool.query`, which takes its own pool connection). The other nine run on one connection in one transaction: `BEGIN`, `SET LOCAL` timeouts, idempotency lookup, user + plans, **account counter lock**, user counter lock, two increments, ledger insert, `COMMIT`. **Five of them run while the account row is locked**: everything from the lock statement up to and including `COMMIT`. A request rejected by a per-request limit stops before the locks (§6.3 step 3).

From `pg_stat_statements` in spread run 2 (no contention), executing all 10 statements takes about **0.4 ms of database time** per request (the means are 0.18 ms for the account counter upsert, 0.07 ms for the ledger insert, 0.03–0.04 ms for each of the others, and almost nothing for `BEGIN`/`SET`/`COMMIT`). Everything else is time between statements.

### spread: the pool is full of connections waiting on round trips

- The pool is saturated for the whole run: `db_pool_total` stays at its maximum of 20 and `db_pool_waiting` averages 77. With 100 VUs and 20 connections, about 80 requests are always queued for a connection.
- Little's law: 1,841 req/s × (9.9 ms in the transaction + about 1 ms for the API-key query) ≈ 20 connections in use. **Throughput = pool size ÷ time each request holds a connection.**
- Of the ~10.9 ms a request holds a connection, the database spends ~0.4 ms executing SQL. The other **~96 % is the 10 round trips** (≈ 1 ms each) between the API and Postgres.
- Neither side is out of CPU: Postgres uses 3.2 of 16 cores and the API 1.1. In the extra event-loop run (1,920 req/s), `nodejs_eventloop_lag_mean` stayed at 10.0–10.5 ms under load and 10.2 ms idle afterwards. That reading is the monitor's 10 ms resolution, with p99 at most 13.7 ms. So the Node main thread is not blocked, and the API process is not the limit at this load.
- Latency is mostly queueing: the server-side mean of 50.4 ms ≈ 2 × 19.8 ms pool acquire (the API-key query and the transaction each queue for a connection) + 9.5 ms transaction.

What is **not** proven: how much of each ~1 ms round trip is the Docker network, the `pg` driver, or the event loop interleaving ~100 in-flight requests between `await`s. The data separates SQL time from time between statements, but not the parts of the latter.

### hot-account, hot-user, exhaust: one row lock serializes everything

- Throughput drops from 1,841 to **322 req/s (hot-account)**, 296 (hot-user) and 306 (exhaust), while CPU use *falls* (db 0.8, api 0.4 cores). The machine is mostly idle, waiting.
- `pg_stat_statements`, hot-account run 2: the account counter upsert takes **56.5 ms per call** (692 ms max), against 0.18 ms in spread, the same statement without contention. Every other statement stays under 0.1 ms. Of the 61.9 ms mean transaction, **91 % is waiting for the account row lock.**
- Little's law again: 322 req/s × 61.9 ms ≈ 20, so all 20 connections are inside a transaction, 19 of them queued behind the lock holder. More connections would only lengthen that queue.
- **The lock is held for ≈ 1 / 322 s ≈ 3.1 ms per request** (§11.1: per-account throughput ≈ 1 / lock hold time). The SQL executed under the lock (the account and user counter statements, two increments, the ledger insert) takes ≈ 0.4 ms of that. **About 2.7 ms, ~87 % of the hold time, is the 5 round trips and the client-side work between them while the lock is held.**
- hot-user is about 8 % slower than hot-account: the user row is also hot, but the user lock is only ever taken while the account lock is held (fixed order), so it adds very little waiting. The 0.04 ms means for the user lock statement say the same.
- Latency: server-side mean 305 ms ≈ 2 × 120.5 ms pool acquire + 61 ms transaction. The pool queue is long *because* the connections are stuck behind the lock. The client sees p50 286 ms and p99 583 ms with 100 VUs on one account.
- exhaust behaves like hot-account: rejected requests (account monthly allowance) also need the lock to read the counter, so they cost the same.

### retry-storm: replays skip the locks

3,120 req/s, the highest of all. A replay is 5 round trips (key lookup, `BEGIN`, `SET`, idempotency lookup, `COMMIT`), takes no row lock, and holds a connection for ≈ 5.1 + 1 ms. 3,120 × 6.1 ms ≈ 19 connections. It is the same pool-bound shape as spread, with half the round trips and about 1.7× the throughput.

### plan-flip: rejections before the lock don't count against it

483 req/s with 50 VUs, of which 283/s were accepted and 200/s were rejected by `max_units_per_request`. `pg_stat_statements` shows the account lock statement ran exactly once per *accepted* request (17,002 calls out of 29,605 consumes in run 2), so the stateless pre-check (§6.3 step 3) kept every rejected request off the lock. The accepted rate, 283/s, sits right at the single-row ceiling seen in hot-account. The 200/s of rejections came on top, without waiting for the lock.

### Summary

1. **Per account, the account row lock is the bottleneck** (hot-account, hot-user, exhaust: ~300 req/s). The lock is held for ~3.1 ms per request, ~87 % of it in the 5 round trips made while holding it, not in SQL.
2. **Across accounts, the bottleneck is connections held during sequential round trips** (spread: 20 connections × ~10.9 ms each ≈ 1,840 req/s). Neither the database (3.2 of 16 cores) nor the API's event loop is saturated.
3. Client latency at 100 VUs is mostly **queueing for a pool connection**, which is a symptom of 1 or 2.

## What Phase 6b should improve, and how it will be measured

Each item from DESIGN.md §11.3 is one change, measured with `load/run-all.sh <label> 3` on this machine and compared with the table above. A change counts only if `verify.sql` passes in every run.

| §11.3 item | Expected effect, from the evidence above | Measured by |
| --- | --- | --- |
| 2. API-key cache (LRU, 30 s TTL) | One round trip and one pool acquire less per request, none of it under the lock. spread and retry-storm should gain (~10 % less connection time per request), with lower latency because the second wait in the pool queue disappears. The lock-bound scenarios shouldn't change much in req/s. | spread, retry-storm req/s; `consume_pool_acquire`; http mean vs tx |
| 3. Fewer round trips (user + plans in one query; upsert + lock merged) | Fewer statements before the lock help spread. Any statement removed from inside the locked section shortens the ~3.1 ms hold, which is the hot-account ceiling. | hot-account req/s (≈ 1 / hold time); tx mean; `pg_stat_statements` mean for the lock statement |
| 4. Stateless pre-check | Already in place and shown working (plan-flip: rejected requests never take the lock). Re-measure on a mix with many oversized requests to put a number on it. | a plan-flip-like mix, lock statement calls vs consumes |
| 5. Single round trip for the locked section (CTE or PL/pgSQL) | The biggest expected gain on one account: the hold drops from 5 round trips to about 1, so hot-account could rise severalfold if the ~87 % share holds. Keep it only if the gain justifies moving logic into SQL. | hot-account, hot-user, exhaust req/s and p99; exhaust must still accept exactly 10,000 |
| 6. Pool size sweep (5/10/20/50) | spread should grow with the pool until the database or the API runs out of CPU. hot-account should not grow (more connections only lengthen the lock queue) and may get worse. | spread and hot-account at each `DB_POOL_MAX`; `db_pool_waiting`; CPU columns |

## Limitations of these numbers

- **Everything runs on one laptop:** k6 takes CPU from the API and the database, and other desktop processes added noise (about 10 % between runs). The numbers are for comparing changes on this machine, not absolute capacity.
- Closed-loop load at fixed concurrency, so throughput is at saturation and latency includes queueing. It says nothing about latency at a fixed, lower arrival rate.
- Each run is 60 s (exhaust ≈ 7 s) from a cold start: JIT warm-up and an empty database are included. The ledger stays small (≤ 120,000 rows), so these numbers say nothing about a large ledger (§11.4).
- `pg_stat_statements` and request logging at `info` are on in every run. Both cost a little, the same in Phase 6b.
- Server-side percentiles in `.metrics.json` are interpolated inside histogram buckets and are approximate. Means (Δsum / Δcount) are exact. The k6 percentiles in the table are exact.

## Phase 6b: improvements

Method, for every step: change one thing, run the full API test suite, then run `load/run-all.sh step-N 3 spread hot-account exhaust` (each run on a fresh stack). Keep the change only if it helps and the code stays clear. All runs are on the machine above.

**Compare each step with step 0, not with the 6a table.** Step 0 re-measured the 6a code on the day of Phase 6b, and hot-account came out at 279 req/s against 322 in the 6a baseline, with identical consume code. The laptop varies by about 10–15 % between sessions, which is as large as some of the effects measured here. Steps 0 to N were measured back to back in one session.

**Lock hold** is `consume_lock_hold_seconds` (added in step 0): from the response of the statement that locks the account row to the end of `COMMIT`. It starts when that response arrives, about half a round trip after Postgres granted the lock, so it reads a little low. 1 / (hot-account req/s) is the other estimate of the same thing.

| Step | Change | hot-account req/s | spread req/s | exhaust req/s | Lock hold ms (hot-account) | Tx mean ms (hot-account / spread) | Result |
| --- | --- | --: | --: | --: | --: | --: | --- |
| 0 | Measure only: add `consume_lock_hold_seconds` | 279 | 1,845 | 286 | 3.18 | 71.2 / 9.9 | reference |
| 1 | Lock both counter rows in one statement; increments + ledger insert in one statement | 375 | 1,982 | 350 | 2.32 | 53.1 / 9.1 | **kept** |

### Step 0: measure lock hold directly

6a could only derive the lock hold time as 1 / (hot-account req/s). Step 0 adds `consume_lock_hold_seconds` (and a scenario list for `run-all.sh`) without touching the consume logic, then re-measures. The measured 3.18 ms on hot-account matches 6a's estimate (≈ 3.1 ms; 1 / 279 req/s = 3.6 ms today). In spread the lock is uncontended but held longer, 5.5 ms, because the API is busier between statements (see 6a: ~1 ms per round trip there). Results: [`load/results/step-0/`](../load/results/step-0/).

### Step 1: fewer round trips while holding the account lock

**Change.** `lockCounters` locks the account row, then the user row, in one statement (two data-modifying CTEs, where the user `INSERT` selects from the account one, so the account row is always locked first; `test/concurrency/lockOrder.test.ts` proves it, and fails if the order is flipped). `recordDecision` adds the units to both counters and appends the ledger row in one statement. The rules engine is unchanged and stays in TypeScript. Under the lock: **5 round trips → 3** (lock both, record, `COMMIT`); per request: 10 → 8.

**Why it should help.** 6a found ~87 % of the 3.1 ms lock hold was round trips, and per-account throughput ≈ 1 / hold.

**What happened.** Lock hold 3.18 → **2.32 ms** (−27 %); hot-account 279 → **375 req/s** (+34 %), exhaust 286 → 350 (+22 %); spread +7 % (two fewer round trips per connection-hold). 1 / 375 req/s = 2.67 ms against 2.32 ms measured: the model holds, with the metric reading ~0.3 ms low as expected. `pg_stat_statements`: the locked section's SQL is now 0.20 ms (record) after the lock statement. exhaust accepted exactly 10,000 in all 3 runs. Results: [`load/results/step-1/`](../load/results/step-1/).
