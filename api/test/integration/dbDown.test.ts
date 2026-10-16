import { Writable } from "node:stream";
import { pino } from "pino";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createPool } from "../../src/db/pool.js";
import { generateApiKey } from "../../src/domain/apiKeys.js";
import { ADMIN_KEY, consumeAs, createMeteredAccount, expectProblem, setupTestApp } from "../helpers.js";
import { assertInvariants } from "../invariants.js";

const { pool, app } = setupTestApp();

describe("database unreachable → 503 SERVICE_UNAVAILABLE on every route (§10)", () => {
  // Port 1 on localhost: nothing listens there, so every connection is refused immediately.
  const lines: string[] = [];
  const logger = pino(
    { level: "error" },
    new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    }),
  );
  const deadPool = createPool({ connectionString: "postgres://x:x@127.0.0.1:1/x", max: 2 }, logger);
  afterAll(() => deadPool.end());
  const deadApp = createApp({ pool: deadPool, logger, adminApiKey: ADMIN_KEY });
  // Well-formed, so requireApiKey goes to the database to look it up.
  const apiKey = generateApiKey().key;

  it("POST /v1/consume", async () => {
    const res = await request(deadApp)
      .post("/v1/consume")
      .set("X-API-Key", apiKey)
      .send({ userId: "alice", units: 1, requestId: "r-1" });
    expectProblem(res, 503, "SERVICE_UNAVAILABLE");
    expect(res.body.title).toBe("Database unavailable");
    // The full error is logged under the request id; the client sees none of it.
    expect(JSON.stringify(res.body)).not.toContain("ECONNREFUSED");
    const logged = lines.filter((l) => l.includes(res.body.requestId)).join("\n");
    expect(logged).toContain("ECONNREFUSED");
  });

  it.each([
    ["GET", "/v1/usage"],
    ["GET", "/v1/requests"],
    ["GET", "/v1/users"],
    ["GET", "/v1/account"],
  ])("%s %s", async (method, path) => {
    const res = await request(deadApp)[method.toLowerCase() as "get"](path).set("X-API-Key", apiKey);
    expectProblem(res, 503, "SERVICE_UNAVAILABLE");
  });

  it("POST /v1/admin/accounts", async () => {
    const res = await request(deadApp).post("/v1/admin/accounts").set("X-Admin-Key", ADMIN_KEY).send({ name: "x" });
    expectProblem(res, 503, "SERVICE_UNAVAILABLE");
  });
});

describe("connection killed in the middle of a consume", () => {
  it("→ 503 SERVICE_UNAVAILABLE, nothing recorded; a retry with the same requestId counts once", async () => {
    const acct = await createMeteredAccount(app, { account: { monthlyAllowance: 100 }, user: {}, users: ["alice"] });
    // Create this month's counter row, then hold its lock from another connection so the
    // consume below parks on it, mid-transaction.
    await consumeAs(app, acct.apiKey, { userId: "alice", units: 1, requestId: "warm-up" }).expect(200);
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT 1 FROM account_monthly_usage
         WHERE account_id = $1 AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date FOR UPDATE`,
        [acct.id],
      );
      const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const holderPid = rows[0]!.pid;

      const pending = consumeAs(app, acct.apiKey, { userId: "alice", units: 5, requestId: "doc-1" }).then((r) => r); // .then() sends it now (supertest is lazy)

      // Find the consume's backend waiting on our lock and end it as an operator would.
      let victim: number | undefined;
      for (let i = 0; i < 150 && victim === undefined; i++) {
        const { rows: waiting } = await pool.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [holderPid],
        );
        victim = waiting[0]?.pid;
        if (victim === undefined) await new Promise((r) => setTimeout(r, 10));
      }
      expect(victim, "consume never waited on the lock").toBeDefined();
      await pool.query("SELECT pg_terminate_backend($1)", [victim]);

      const res = await pending;
      expectProblem(res, 503, "SERVICE_UNAVAILABLE");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }

    const { rows } = await pool.query("SELECT 1 FROM usage_requests WHERE account_id = $1 AND request_id = 'doc-1'", [
      acct.id,
    ]);
    expect(rows).toHaveLength(0);
    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 1, users: { alice: 1 } });

    const retry = await consumeAs(app, acct.apiKey, { userId: "alice", units: 5, requestId: "doc-1" });
    expect(retry.body).toMatchObject({ decision: "accepted", replayed: false, account: { used: 6 } });
    const again = await consumeAs(app, acct.apiKey, { userId: "alice", units: 5, requestId: "doc-1" });
    expect(again.body).toMatchObject({ decision: "accepted", replayed: true });
    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 6, users: { alice: 6 } });
  });
});
