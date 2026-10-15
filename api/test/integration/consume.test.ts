import request from "supertest";
import { describe, expect, it } from "vitest";
import { PLAN_IDS } from "../../src/db/seed.js";
import {
  consumeAs,
  createMeteredAccount,
  createTestAccount,
  createTestUser,
  expectProblem,
  type MeteredAccount,
  setupTestApp,
} from "../helpers.js";
import { assertInvariants } from "../invariants.js";

const { pool, app } = setupTestApp();

// The brief's numbers: account 10,000/100, user 1,000/20 (as custom plans, so exact).
const BRIEF = { account: { monthlyAllowance: 10_000, maxUnitsPerRequest: 100 }, user: { monthlyAllowance: 1_000, maxUnitsPerRequest: 20 } };

const month = () => new Date().toISOString().slice(0, 7);

async function ledger(accountId: string) {
  const { rows } = await pool.query(
    `SELECT r.request_id, u.external_id, r.units::int, r.decision, r.reject_scope, r.reject_rule,
            r.account_plan_id, r.account_plan_version, r.user_plan_id, r.user_plan_version, r.evaluation
     FROM usage_requests r JOIN users u ON u.id = r.user_id
     WHERE r.account_id = $1 ORDER BY r.id`,
    [accountId],
  );
  return rows;
}

const patchPlan = (acct: MeteredAccount, planId: string, rules: object) =>
  request(app).patch(`/v1/plans/${planId}`).set("X-API-Key", acct.apiKey).send({ rules }).expect(200);

describe("the brief's examples, end to end", () => {
  it("25 units → rejected by the user's max_units_per_request; nothing consumed", async () => {
    const acct = await createMeteredAccount(app, { ...BRIEF, users: ["alice"] });

    const res = await consumeAs(app, acct.apiKey, { userId: "alice", units: 25, requestId: "r-25" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      requestId: "r-25",
      decision: "rejected",
      units: 25,
      reason: { scope: "user", rule: "max_units_per_request", limit: 20, actual: 25 },
      replayed: false,
    });
    expect(res.body.violations).toHaveLength(1);
    expect(res.body.user).toMatchObject({ used: 0, remaining: 1_000 });

    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 0, users: { alice: 0 } });
  });

  it("10 units → accepted; user used 10 and account used 10", async () => {
    const acct = await createMeteredAccount(app, { ...BRIEF, users: ["alice"] });

    const res = await consumeAs(app, acct.apiKey, { userId: "alice", units: 10, requestId: "r-10" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      requestId: "r-10",
      decision: "accepted",
      units: 10,
      month: month(),
      violations: [],
      account: {
        planId: acct.accountPlanId,
        planName: expect.any(String),
        planVersion: 1,
        monthlyAllowance: 10_000,
        maxUnitsPerRequest: 100,
        used: 10,
        remaining: 9_990,
      },
      user: {
        planId: acct.userPlanId,
        planName: expect.any(String),
        planVersion: 1,
        monthlyAllowance: 1_000,
        maxUnitsPerRequest: 20,
        used: 10,
        remaining: 990,
      },
      replayed: false,
    });
    expect(res.headers["idempotent-replayed"]).toBeUndefined();

    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 10, users: { alice: 10 } });
  });

  it("account has 5 left, user has plenty → 10 rejected by the account's monthly_allowance", async () => {
    const acct = await createMeteredAccount(app, {
      account: { monthlyAllowance: 60, maxUnitsPerRequest: 50 },
      user: { monthlyAllowance: 5_000, maxUnitsPerRequest: 100 },
      users: ["bob", "carol"],
    });
    expect((await consumeAs(app, acct.apiKey, { userId: "bob", units: 50 })).body.decision).toBe("accepted");
    expect((await consumeAs(app, acct.apiKey, { userId: "bob", units: 5 })).body.decision).toBe("accepted");

    const res = await consumeAs(app, acct.apiKey, { userId: "carol", units: 10 });
    expect(res.body).toMatchObject({
      decision: "rejected",
      reason: {
        scope: "account",
        rule: "monthly_allowance",
        limit: 60,
        actual: 65,
        message: "Account monthly allowance exceeded: 55 used + 10 requested > 60",
      },
      account: { used: 55, remaining: 5 },
      user: { used: 0, remaining: 5_000 },
    });

    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 55, users: { bob: 55, carol: 0 } });
  });
});

describe("rules and plan changes", () => {
  it("rejections consume nothing and are recorded in the ledger with their reason", async () => {
    const acct = await createMeteredAccount(app, {
      account: { monthlyAllowance: 30 },
      user: { maxUnitsPerRequest: 20 },
      users: ["alice"],
    });
    await consumeAs(app, acct.apiKey, { userId: "alice", units: 25, requestId: "too-big" }); // per-request
    await consumeAs(app, acct.apiKey, { userId: "alice", units: 20, requestId: "ok" }); // accepted
    await consumeAs(app, acct.apiKey, { userId: "alice", units: 15, requestId: "over-month" }); // monthly

    const rows = await ledger(acct.id);
    expect(rows.map((r) => [r.request_id, r.decision, r.reject_scope, r.reject_rule])).toEqual([
      ["too-big", "rejected", "user", "max_units_per_request"],
      ["ok", "accepted", null, null],
      ["over-month", "rejected", "account", "monthly_allowance"],
    ]);
    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 20, users: { alice: 20 } });
  });

  it("PATCHing the user plan's maxUnitsPerRequest 20 → 30 lets 25 through, no restart", async () => {
    const acct = await createMeteredAccount(app, { ...BRIEF, users: ["alice"] });
    expect((await consumeAs(app, acct.apiKey, { userId: "alice", units: 25 })).body.decision).toBe("rejected");

    await patchPlan(acct, acct.userPlanId, { maxUnitsPerRequest: 30 });

    const res = await consumeAs(app, acct.apiKey, { userId: "alice", units: 25 });
    expect(res.body).toMatchObject({ decision: "accepted", user: { planVersion: 2, maxUnitsPerRequest: 30, used: 25 } });
    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 25, users: { alice: 25 } });
  });

  it("switching a user's plan keeps used; an allowance below used → remaining 0 and rejected", async () => {
    const acct = await createMeteredAccount(app, { account: {}, user: { monthlyAllowance: 100 }, users: ["alice"] });
    await consumeAs(app, acct.apiKey, { userId: "alice", units: 50 }).expect(200);

    // Switch alice to a plan whose allowance (30) is below what she already used (50).
    const small = await request(app)
      .post("/v1/plans")
      .set("X-API-Key", acct.apiKey)
      .send({ name: "Small", scope: "user", rules: { monthlyAllowance: 30 } });
    await request(app).put("/v1/users/alice/plan").set("X-API-Key", acct.apiKey).send({ planId: small.body.id }).expect(200);

    const res = await consumeAs(app, acct.apiKey, { userId: "alice", units: 1 });
    expect(res.body).toMatchObject({
      decision: "rejected",
      reason: { scope: "user", rule: "monthly_allowance", limit: 30, actual: 51 },
      user: { planId: small.body.id, used: 50, remaining: 0 },
    });

    // Lowering the allowance in place (PATCH) behaves the same.
    await patchPlan(acct, small.body.id, { monthlyAllowance: 10 });
    const after = await consumeAs(app, acct.apiKey, { userId: "alice", units: 1 });
    expect(after.body).toMatchObject({ decision: "rejected", user: { monthlyAllowance: 10, used: 50, remaining: 0 } });

    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 50, users: { alice: 50 } });
  });

  it("two users on the same custom plan keep separate totals", async () => {
    const acct = await createMeteredAccount(app, { account: {}, user: { monthlyAllowance: 30 }, users: ["alice", "bob"] });
    await consumeAs(app, acct.apiKey, { userId: "alice", units: 30 }).expect(200);

    const bob = await consumeAs(app, acct.apiKey, { userId: "bob", units: 30 });
    expect(bob.body).toMatchObject({ decision: "accepted", user: { used: 30, remaining: 0 } });
    const alice = await consumeAs(app, acct.apiKey, { userId: "alice", units: 1 });
    expect(alice.body.reason).toMatchObject({ scope: "user", rule: "monthly_allowance" });

    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 60, users: { alice: 30, bob: 30 } });
  });

  it("the ledger row records the plan ids and versions the decision used", async () => {
    const acct = await createMeteredAccount(app, { ...BRIEF, users: ["alice"] });
    await patchPlan(acct, acct.accountPlanId, { monthlyAllowance: 20_000 }); // account plan → v2

    const res = await consumeAs(app, acct.apiKey, { userId: "alice", units: 5, requestId: "versioned" });
    const [row] = await ledger(acct.id);
    expect(row).toMatchObject({
      request_id: "versioned",
      account_plan_id: acct.accountPlanId,
      account_plan_version: 2,
      user_plan_id: acct.userPlanId,
      user_plan_version: 1,
      evaluation: res.body, // the stored snapshot is exactly the response
    });
    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 5, users: { alice: 5 } });
  });

  it("a missing rule is unlimited and a 0 limit blocks everything", async () => {
    const acct = await createMeteredAccount(app, { account: {}, user: {}, users: ["free"] });
    const res = await consumeAs(app, acct.apiKey, { userId: "free", units: 1_000_000_000 });
    expect(res.body).toMatchObject({ decision: "accepted", user: { remaining: null }, account: { remaining: null } });

    await patchPlan(acct, acct.userPlanId, { monthlyAllowance: 0 });
    expect((await consumeAs(app, acct.apiKey, { userId: "free", units: 1 })).body.reason).toMatchObject({ limit: 0 });
    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 1_000_000_000, users: { free: 1_000_000_000 } });
  });
});

describe("idempotency", () => {
  it("the same request twice → one increment; the retry is identical except replayed + header", async () => {
    const acct = await createMeteredAccount(app, { ...BRIEF, users: ["alice"] });
    const first = await consumeAs(app, acct.apiKey, { userId: "alice", units: 10, requestId: "doc-1" });
    const second = await consumeAs(app, acct.apiKey, { userId: "alice", units: 10, requestId: "doc-1" });

    expect(second.status).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual({ ...first.body, replayed: true });
    // Byte-identical too (jsonb reorders keys; the replay must not).
    expect(second.text).toBe(first.text.replace('"replayed":false', '"replayed":true'));
    expect(await ledger(acct.id)).toHaveLength(1);
    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 10, users: { alice: 10 } });
  });

  it("a replay returns the decision-time numbers, not today's", async () => {
    const acct = await createMeteredAccount(app, { ...BRIEF, users: ["alice"] });
    await consumeAs(app, acct.apiKey, { userId: "alice", units: 10, requestId: "a" });
    await consumeAs(app, acct.apiKey, { userId: "alice", units: 10, requestId: "b" });

    const replay = await consumeAs(app, acct.apiKey, { userId: "alice", units: 10, requestId: "a" });
    expect(replay.body).toMatchObject({ replayed: true, user: { used: 10, remaining: 990 } });
    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 20, users: { alice: 20 } });
  });

  it("a stored rejection stays rejected even after the plan is upgraded", async () => {
    const acct = await createMeteredAccount(app, { ...BRIEF, users: ["alice"] });
    await consumeAs(app, acct.apiKey, { userId: "alice", units: 25, requestId: "big" });
    await patchPlan(acct, acct.userPlanId, { maxUnitsPerRequest: 50 });

    const retry = await consumeAs(app, acct.apiKey, { userId: "alice", units: 25, requestId: "big" });
    expect(retry.body).toMatchObject({ decision: "rejected", replayed: true });
    const fresh = await consumeAs(app, acct.apiKey, { userId: "alice", units: 25, requestId: "big-2" });
    expect(fresh.body.decision).toBe("accepted");
    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 25, users: { alice: 25 } });
  });

  it("409 IDEMPOTENCY_CONFLICT for the same requestId with different units or user; nothing changes", async () => {
    const acct = await createMeteredAccount(app, { ...BRIEF, users: ["alice", "bob"] });
    await consumeAs(app, acct.apiKey, { userId: "alice", units: 10, requestId: "dup" }).expect(200);

    expectProblem(await consumeAs(app, acct.apiKey, { userId: "alice", units: 11, requestId: "dup" }), 409, "IDEMPOTENCY_CONFLICT");
    expectProblem(await consumeAs(app, acct.apiKey, { userId: "bob", units: 10, requestId: "dup" }), 409, "IDEMPOTENCY_CONFLICT");

    expect(await ledger(acct.id)).toHaveLength(1);
    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 10, users: { alice: 10, bob: 0 } });
  });

  it("404 unknown user and 400 invalid body are not recorded; the requestId works afterwards", async () => {
    const acct = await createMeteredAccount(app, { ...BRIEF, users: [] });

    expectProblem(await consumeAs(app, acct.apiKey, { userId: "late", units: 5, requestId: "keep" }), 404, "USER_NOT_FOUND");
    expectProblem(await consumeAs(app, acct.apiKey, { userId: "late", units: 0, requestId: "keep" }), 400, "VALIDATION_ERROR");
    expect(await ledger(acct.id)).toHaveLength(0);

    await createTestUser(app, acct.apiKey, { externalId: "late", planId: acct.userPlanId });
    const res = await consumeAs(app, acct.apiKey, { userId: "late", units: 5, requestId: "keep" });
    expect(res.body).toMatchObject({ decision: "accepted", replayed: false });
    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 5, users: { late: 5 } });
  });

  it("the same requestId under two accounts is processed independently", async () => {
    const a = await createMeteredAccount(app, { ...BRIEF, users: ["alice"] });
    const b = await createMeteredAccount(app, { ...BRIEF, users: ["alice"] });

    const ra = await consumeAs(app, a.apiKey, { userId: "alice", units: 3, requestId: "shared-id" });
    const rb = await consumeAs(app, b.apiKey, { userId: "alice", units: 7, requestId: "shared-id" });
    expect([ra.body.replayed, rb.body.replayed]).toEqual([false, false]);
    expect(await assertInvariants(pool, a.id)).toEqual({ account: 3, users: { alice: 3 } });
    expect(await assertInvariants(pool, b.id)).toEqual({ account: 7, users: { alice: 7 } });
  });
});

describe("tenant isolation", () => {
  it("account A consuming for account B's user → 404; B's counters and ledger unchanged", async () => {
    const a = await createMeteredAccount(app, { ...BRIEF, users: [] });
    const b = await createMeteredAccount(app, { ...BRIEF, users: ["bob"] });
    await consumeAs(app, b.apiKey, { userId: "bob", units: 4 }).expect(200);

    expectProblem(await consumeAs(app, a.apiKey, { userId: "bob", units: 5 }), 404, "USER_NOT_FOUND");

    expect(await ledger(b.id)).toHaveLength(1);
    expect(await assertInvariants(pool, b.id)).toEqual({ account: 4, users: { bob: 4 } });
    expect(await assertInvariants(pool, a.id)).toEqual({ account: 0, users: {} });
  });

  it("an accountId in the body is rejected, never used", async () => {
    const a = await createMeteredAccount(app, { ...BRIEF, users: ["alice"] });
    const res = await request(app)
      .post("/v1/consume")
      .set("X-API-Key", a.apiKey)
      .send({ userId: "alice", units: 1, requestId: "x", accountId: crypto.randomUUID() });
    expectProblem(res, 400, "VALIDATION_ERROR");
    expect(await assertInvariants(pool, a.id)).toEqual({ account: 0, users: { alice: 0 } });
  });
});

describe("validation", () => {
  it("400 VALIDATION_ERROR for bad units, userId and requestId; nothing recorded", async () => {
    const acct = await createMeteredAccount(app, { ...BRIEF, users: ["alice"] });
    const cases: [object, string][] = [
      [{ userId: "alice", units: 0, requestId: "a" }, "body.units"],
      [{ userId: "alice", units: -1, requestId: "a" }, "body.units"],
      [{ userId: "alice", units: 1.5, requestId: "a" }, "body.units"],
      [{ userId: "alice", units: "10", requestId: "a" }, "body.units"],
      [{ userId: "alice", units: 1_000_000_001, requestId: "a" }, "body.units"],
      [{ userId: "alice", requestId: "a" }, "body.units"],
      [{ userId: "", units: 1, requestId: "a" }, "body.userId"],
      [{ userId: "alice", units: 1, requestId: "" }, "body.requestId"],
      [{ userId: "alice", units: 1, requestId: "x".repeat(201) }, "body.requestId"],
      [{ userId: "alice", units: 1, requestId: "nul\u0000byte" }, "body.requestId"],
      [{ userId: "alice", units: 1 }, "body.requestId"],
    ];
    for (const [body, path] of cases) {
      const res = await request(app).post("/v1/consume").set("X-API-Key", acct.apiKey).send(body);
      expectProblem(res, 400, "VALIDATION_ERROR");
      expect(res.body.errors.map((e: { path: string }) => e.path)).toContain(path);
    }
    expect(await ledger(acct.id)).toHaveLength(0);
    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 0, users: { alice: 0 } });
  });

  it("401 without an API key", async () => {
    expectProblem(await request(app).post("/v1/consume").send({ userId: "a", units: 1, requestId: "r" }), 401, "MISSING_API_KEY");
  });
});

describe("contention timeout", () => {
  it("503 SERVICE_BUSY when the account row stays locked past lock_timeout; nothing recorded; retry works", async () => {
    const acct = await createMeteredAccount(app, { ...BRIEF, users: ["alice"] });
    await consumeAs(app, acct.apiKey, { userId: "alice", units: 1 }).expect(200); // creates the counter row

    // Another session holds the account counter row lock, like a stuck transaction would.
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT used FROM account_monthly_usage WHERE account_id = $1 FOR UPDATE",
        [acct.id],
      );
      const res = await consumeAs(app, acct.apiKey, { userId: "alice", units: 2, requestId: "busy" });
      expectProblem(res, 503, "SERVICE_BUSY");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    expect((await ledger(acct.id)).map((r) => r.request_id)).not.toContain("busy");
    const retry = await consumeAs(app, acct.apiKey, { userId: "alice", units: 2, requestId: "busy" });
    expect(retry.body).toMatchObject({ decision: "accepted", replayed: false });
    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 3, users: { alice: 3 } });
  });

  it("a per-request rejection takes no counter lock, so it is answered even while the row is locked", async () => {
    const acct = await createMeteredAccount(app, { ...BRIEF, users: ["alice"] });
    await consumeAs(app, acct.apiKey, { userId: "alice", units: 1 }).expect(200);

    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT used FROM account_monthly_usage WHERE account_id = $1 FOR UPDATE", [acct.id]);
      const started = Date.now();
      const res = await consumeAs(app, acct.apiKey, { userId: "alice", units: 25 });
      expect(res.body).toMatchObject({ decision: "rejected", reason: { rule: "max_units_per_request" } });
      expect(Date.now() - started).toBeLessThan(1_000); // well under the 2s lock_timeout
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 1, users: { alice: 1 } });
  });
});
