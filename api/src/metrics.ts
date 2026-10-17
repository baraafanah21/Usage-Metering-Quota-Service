import type { Request } from "express";
import type { Pool } from "pg";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

// One registry per process (DESIGN.md §12). Modules are evaluated once, so the metrics below
// are registered once however many apps a process builds (tests build several).
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

// Finer than prom-client's default at the low end: a consume takes a few milliseconds.
const LATENCY_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration, by route pattern (not raw path), method and status",
  labelNames: ["route", "method", "status"] as const,
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

export const consumeDecisions = new Counter({
  name: "consume_decisions_total",
  help: "New consume decisions (replays excluded). scope/rule are 'none' when accepted",
  labelNames: ["decision", "scope", "rule"] as const,
  registers: [registry],
});

export const consumeReplays = new Counter({
  name: "consume_replays_total",
  help: "Consumes answered with an already-recorded decision (same requestId and payload)",
  registers: [registry],
});

export const consumeIdempotencyConflicts = new Counter({
  name: "consume_idempotency_conflicts_total",
  help: "Consumes rejected with 409 IDEMPOTENCY_CONFLICT (requestId reused with another payload)",
  registers: [registry],
});

export const consumeTxDuration = new Histogram({
  name: "consume_tx_duration_seconds",
  help: "Consume transaction duration, BEGIN to COMMIT/ROLLBACK, on a connection already acquired",
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

export const consumeLockHold = new Histogram({
  name: "consume_lock_hold_seconds",
  help: "From the account counter lock statement's response to the end of COMMIT: how long a consume held the account row",
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

export const consumePoolAcquire = new Histogram({
  name: "consume_pool_acquire_seconds",
  help: "Time a consume waited for a pool connection before BEGIN",
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

const poolTotal = new Gauge({ name: "db_pool_total", help: "Connections open in the pool", registers: [registry] });
const poolIdle = new Gauge({ name: "db_pool_idle", help: "Open connections not checked out", registers: [registry] });
const poolWaiting = new Gauge({
  name: "db_pool_waiting",
  help: "Callers queued for a connection because all are checked out",
  registers: [registry],
});

/** Reads the pool gauges at scrape time, so they are exact when /metrics is read. */
export function samplePool(pool: Pool): void {
  poolTotal.set(pool.totalCount);
  poolIdle.set(pool.idleCount);
  poolWaiting.set(pool.waitingCount);
}

/**
 * The route pattern for the http_request_duration_seconds label, e.g. "/v1/users/:externalId".
 * Raw paths would create one series per user id. Express keeps req.route after an error but
 * resets req.baseUrl, so the mount prefix is taken from the path instead: every mount path is
 * static, so dropping the route's own segments from the path leaves exactly that prefix.
 * Requests that matched no route (unknown paths, 401s from the /v1 key guard) share one label.
 */
export function routeLabel(req: Request): string {
  const pattern: unknown = req.route?.path;
  if (typeof pattern !== "string") return "unmatched";
  const pathSegments = req.originalUrl.split("?")[0]!.split("/").filter(Boolean);
  const routeSegments = pattern.split("/").filter(Boolean);
  const prefix = pathSegments.slice(0, pathSegments.length - routeSegments.length);
  return "/" + [...prefix, ...routeSegments].join("/");
}
