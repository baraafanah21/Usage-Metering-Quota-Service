import request from "supertest";
import { describe, expect, it } from "vitest";
import { consumeAs, createMeteredAccount, setupTestApp } from "../helpers.js";

const { app } = setupTestApp();

async function scrape(): Promise<string> {
  const res = await request(app).get("/metrics");
  expect(res.status).toBe(200);
  return res.text;
}

/** The value of one series, e.g. sample(text, "consume_decisions_total", {decision: "accepted", …}). 0 if absent. */
function sample(text: string, name: string, labels: Record<string, string> = {}): number {
  const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const line of text.split("\n")) {
    const match = /^([a-z_]+)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (!match || match[1] !== name) continue;
    const have = match[2] ? match[2].split(",") : [];
    if (wanted.length === have.length && wanted.every((l) => have.includes(l))) return Number(match[3]);
  }
  return 0;
}

describe("GET /metrics", () => {
  it("serves Prometheus text with the pool gauges and default process metrics, without auth", async () => {
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain; version=0\.0\.4/);
    for (const name of ["db_pool_total", "db_pool_idle", "db_pool_waiting", "process_cpu_seconds_total", "nodejs_eventloop_lag_seconds"]) {
      expect(res.text).toMatch(new RegExp(`^${name} \\d`, "m"));
    }
  });

  it("moves the consume counters and histograms for decisions, replays and conflicts", async () => {
    const account = await createMeteredAccount(app, {
      account: { monthlyAllowance: 1_000 },
      user: { maxUnitsPerRequest: 10 },
      users: ["alice"],
    });
    const before = await scrape();

    const accepted = await consumeAs(app, account.apiKey, { userId: "alice", units: 5, requestId: "m-1" });
    expect(accepted.body.decision).toBe("accepted");
    const rejected = await consumeAs(app, account.apiKey, { userId: "alice", units: 11 });
    expect(rejected.body.decision).toBe("rejected");
    const replay = await consumeAs(app, account.apiKey, { userId: "alice", units: 5, requestId: "m-1" });
    expect(replay.body.replayed).toBe(true);
    const conflict = await consumeAs(app, account.apiKey, { userId: "alice", units: 6, requestId: "m-1" });
    expect(conflict.status).toBe(409);

    const after = await scrape();
    const delta = (name: string, labels?: Record<string, string>) => sample(after, name, labels) - sample(before, name, labels);

    expect(delta("consume_decisions_total", { decision: "accepted", scope: "none", rule: "none" })).toBe(1);
    expect(delta("consume_decisions_total", { decision: "rejected", scope: "user", rule: "max_units_per_request" })).toBe(1);
    expect(delta("consume_replays_total")).toBe(1);
    expect(delta("consume_idempotency_conflicts_total")).toBe(1);
    // One transaction per consume, including the replay and the conflict (both roll back).
    expect(delta("consume_tx_duration_seconds_count")).toBe(4);
    expect(delta("consume_pool_acquire_seconds_count")).toBe(4);
    expect(delta("consume_tx_duration_seconds_sum")).toBeGreaterThan(0);
    // Only the accepted consume reached the counter locks: the oversized one was rejected
    // before them, the replay and the conflict were answered from the ledger.
    expect(delta("consume_lock_hold_seconds_count")).toBe(1);
    expect(delta("http_request_duration_seconds_count", { route: "/v1/consume", method: "POST", status: "200" })).toBe(3);
    expect(delta("http_request_duration_seconds_count", { route: "/v1/consume", method: "POST", status: "409" })).toBe(1);
  });

  it("labels requests by route pattern, also when the route answers with an error", async () => {
    const account = await createMeteredAccount(app, { account: {}, user: {}, users: ["bob"] });
    const before = await scrape();

    await request(app).get("/v1/users/bob/limits").set("X-API-Key", account.apiKey).expect(200);
    await request(app).get("/v1/users/nobody/limits?x=1").set("X-API-Key", account.apiKey).expect(404);
    await request(app).get(`/no-such-path/${crypto.randomUUID()}`).expect(404);

    const after = await scrape();
    const delta = (labels: Record<string, string>) =>
      sample(after, "http_request_duration_seconds_count", labels) -
      sample(before, "http_request_duration_seconds_count", labels);

    expect(delta({ route: "/v1/users/:externalId/limits", method: "GET", status: "200" })).toBe(1);
    expect(delta({ route: "/v1/users/:externalId/limits", method: "GET", status: "404" })).toBe(1);
    expect(delta({ route: "unmatched", method: "GET", status: "404" })).toBe(1);
    // No series is keyed by a raw id.
    expect(after).not.toMatch(/route="[^"]*(bob|nobody|no-such-path)/);
  });
});
