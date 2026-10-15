import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  consumeAs,
  createMeteredAccount,
  createTestAccount,
  createTestUser,
  currentMonth,
  expectProblem,
  seedLastMonth,
  setupTestApp,
} from "../helpers.js";
import { assertInvariants } from "../invariants.js";

const { pool, app } = setupTestApp();

const getUsage = (apiKey: string, query: Record<string, string | number> = {}) =>
  request(app).get("/v1/usage").query(query).set("X-API-Key", apiKey);

const getUserUsage = (apiKey: string, externalId: string, query: Record<string, string> = {}) =>
  request(app).get(`/v1/users/${externalId}/usage`).query(query).set("X-API-Key", apiKey);

const MALFORMED_MONTHS = ["2026-13", "2026-00", "2026-1", "26-10", "2026-10-01", "abcd-ef", "0000-01", ""];

describe("GET /v1/usage", () => {
  it("after a mix of consumes: account used == Σ users' used, remaining correct at each level", async () => {
    const acct = await createMeteredAccount(app, {
      account: { monthlyAllowance: 100 },
      user: { monthlyAllowance: 30, maxUnitsPerRequest: 20 },
      users: ["alice", "bob", "carol", "dave"],
    });
    const calls: [string, number, "accepted" | "rejected"][] = [
      ["alice", 10, "accepted"],
      ["alice", 15, "accepted"],
      ["alice", 10, "rejected"], // user monthly: 25 + 10 > 30
      ["bob", 25, "rejected"], // user per-request: 25 > 20
      ["bob", 20, "accepted"],
      ["carol", 20, "accepted"],
      ["carol", 5, "accepted"],
    ];
    for (const [userId, units, expected] of calls) {
      const res = await consumeAs(app, acct.apiKey, { userId, units });
      expect(res.body.decision, `${userId} ${units}`).toBe(expected);
    }

    const res = await getUsage(acct.apiKey);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      month: await currentMonth(pool),
      account: {
        planId: acct.accountPlanId,
        planName: expect.any(String),
        monthlyAllowance: 100,
        used: 70,
        remaining: 30,
      },
      users: [
        { userId: "alice", planName: expect.any(String), monthlyAllowance: 30, used: 25, remaining: 5 },
        { userId: "bob", planName: expect.any(String), monthlyAllowance: 30, used: 20, remaining: 10 },
        { userId: "carol", planName: expect.any(String), monthlyAllowance: 30, used: 25, remaining: 5 },
        // Registered, never consumed: no counter row, still listed with used 0.
        { userId: "dave", planName: expect.any(String), monthlyAllowance: 30, used: 0, remaining: 30 },
      ],
      nextCursor: null,
    });

    const sumOfUsers = res.body.users.reduce((sum: number, u: { used: number }) => sum + u.used, 0);
    expect(res.body.account.used).toBe(sumOfUsers);
    const totals = await assertInvariants(pool, acct.id);
    expect(totals).toEqual({ account: 70, users: { alice: 25, bob: 20, carol: 25, dave: 0 } });
  });

  it("an unlimited level reports monthlyAllowance and remaining as null", async () => {
    const acct = await createMeteredAccount(app, { account: {}, user: {}, users: ["alice"] });
    await consumeAs(app, acct.apiKey, { userId: "alice", units: 7 }).expect(200);

    const res = await getUsage(acct.apiKey);
    expect(res.body.account).toMatchObject({ monthlyAllowance: null, used: 7, remaining: null });
    expect(res.body.users).toEqual([
      { userId: "alice", planName: expect.any(String), monthlyAllowance: null, used: 7, remaining: null },
    ]);
  });

  it("a month with no data → used 0 everywhere", async () => {
    const acct = await createMeteredAccount(app, { account: { monthlyAllowance: 100 }, user: {}, users: ["alice"] });
    await consumeAs(app, acct.apiKey, { userId: "alice", units: 7 }).expect(200);

    const res = await getUsage(acct.apiKey, { month: "2001-01" });
    expect(res.status).toBe(200);
    expect(res.body.month).toBe("2001-01");
    expect(res.body.account).toMatchObject({ used: 0, remaining: 100 });
    expect(res.body.users).toMatchObject([{ userId: "alice", used: 0 }]);
  });

  it("a malformed month → 400 VALIDATION_ERROR", async () => {
    const acct = await createTestAccount(app);
    for (const month of MALFORMED_MONTHS) {
      const res = await getUsage(acct.apiKey, { month });
      expectProblem(res, 400, "VALIDATION_ERROR");
      expect(res.body.errors).toEqual([{ path: "query.month", message: expect.any(String) }]);
    }
  });

  it("previous month: shows last month's numbers; this month starts at 0; an exhausted user can consume again", async () => {
    const acct = await createMeteredAccount(app, {
      account: { monthlyAllowance: 100 },
      user: { monthlyAllowance: 30 },
      users: ["alice", "bob"],
    });
    const lastMonth = await seedLastMonth(pool, acct.id, [
      { externalId: "alice", units: 30, decision: "accepted", requestId: "old-1" },
      { externalId: "bob", units: 10, decision: "accepted", requestId: "old-2" },
      { externalId: "bob", units: 25, decision: "rejected", requestId: "old-3" },
    ]);

    const past = await getUsage(acct.apiKey, { month: lastMonth });
    expect(past.status).toBe(200);
    expect(past.body.month).toBe(lastMonth);
    expect(past.body.account).toMatchObject({ used: 40, remaining: 60 });
    expect(past.body.users).toMatchObject([
      { userId: "alice", used: 30, remaining: 0 },
      { userId: "bob", used: 10, remaining: 20 },
    ]);
    expect((await getUserUsage(acct.apiKey, "alice", { month: lastMonth })).body).toMatchObject({
      month: lastMonth,
      userId: "alice",
      used: 30,
      remaining: 0,
    });

    const now = await getUsage(acct.apiKey);
    expect(now.body.month).not.toBe(lastMonth);
    expect(now.body.account).toMatchObject({ used: 0, remaining: 100 });
    expect(now.body.users).toMatchObject([
      { userId: "alice", used: 0, remaining: 30 },
      { userId: "bob", used: 0, remaining: 30 },
    ]);

    // alice used her whole allowance last month; this month's counter is a new row.
    const res = await consumeAs(app, acct.apiKey, { userId: "alice", units: 10 });
    expect(res.body).toMatchObject({ decision: "accepted", user: { used: 10, remaining: 20 } });
    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 10, users: { alice: 10, bob: 0 } });
    // Last month is untouched.
    expect((await getUsage(acct.apiKey, { month: lastMonth })).body.account.used).toBe(40);
  });

  it("past-month remaining uses the plan assigned now (assumption 15)", async () => {
    const acct = await createMeteredAccount(app, { account: {}, user: { monthlyAllowance: 30 }, users: ["alice"] });
    const lastMonth = await seedLastMonth(pool, acct.id, [
      { externalId: "alice", units: 30, decision: "accepted", requestId: "old-1" },
    ]);
    await request(app)
      .patch(`/v1/plans/${acct.userPlanId}`)
      .set("X-API-Key", acct.apiKey)
      .send({ rules: { monthlyAllowance: 50 } })
      .expect(200);

    const res = await getUserUsage(acct.apiKey, "alice", { month: lastMonth });
    expect(res.body).toMatchObject({ monthlyAllowance: 50, used: 30, remaining: 20 });
  });

  it("pagination covers every user exactly once, in GET /v1/users order", async () => {
    const users = Array.from({ length: 25 }, (_, i) => `user-${String(i).padStart(2, "0")}`);
    const acct = await createMeteredAccount(app, { account: {}, user: {}, users });
    await consumeAs(app, acct.apiKey, { userId: "user-03", units: 4 }).expect(200);

    const seen: { userId: string; used: number }[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await getUsage(acct.apiKey, { limit: 7, ...(cursor && { cursor }) });
      expect(res.status).toBe(200);
      expect(res.body.users.length).toBeLessThanOrEqual(7);
      seen.push(...res.body.users);
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(4);
    const listed = await request(app).get("/v1/users").query({ limit: 100 }).set("X-API-Key", acct.apiKey);
    expect(seen.map((u) => u.userId)).toEqual(listed.body.users.map((u: { externalId: string }) => u.externalId));
    expect(new Set(seen.map((u) => u.userId)).size).toBe(25);
    expect(seen.reduce((sum, u) => sum + u.used, 0)).toBe(4);
  });

  it("rejects a bad cursor and an out-of-range limit", async () => {
    const acct = await createTestAccount(app);
    expectProblem(await getUsage(acct.apiKey, { cursor: "not-a-cursor" }), 400, "INVALID_CURSOR");
    expectProblem(await getUsage(acct.apiKey, { limit: 0 }), 400, "VALIDATION_ERROR");
    expectProblem(await getUsage(acct.apiKey, { limit: 101 }), 400, "VALIDATION_ERROR");
  });

  it("shows only the caller's own users", async () => {
    const a = await createMeteredAccount(app, { account: {}, user: {}, users: ["alice"] });
    const b = await createMeteredAccount(app, { account: {}, user: {}, users: ["bob"] });
    await consumeAs(app, a.apiKey, { userId: "alice", units: 5 }).expect(200);

    const res = await getUsage(b.apiKey);
    expect(res.body.account.used).toBe(0);
    expect(res.body.users.map((u: { userId: string }) => u.userId)).toEqual(["bob"]);
  });
});

describe("GET /v1/users/:externalId/usage", () => {
  it("returns the user's used/remaining for the current month by default", async () => {
    const acct = await createMeteredAccount(app, { account: {}, user: { monthlyAllowance: 30 }, users: ["alice"] });
    await consumeAs(app, acct.apiKey, { userId: "alice", units: 12 }).expect(200);

    const res = await getUserUsage(acct.apiKey, "alice");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      month: await currentMonth(pool),
      userId: "alice",
      planId: acct.userPlanId,
      planName: expect.any(String),
      monthlyAllowance: 30,
      used: 12,
      remaining: 18,
    });
  });

  it("a user on a predefined plan with no usage this month → used 0", async () => {
    const acct = await createTestAccount(app);
    await createTestUser(app, acct.apiKey, { externalId: "carol" });
    const res = await getUserUsage(acct.apiKey, "carol");
    expect(res.body).toMatchObject({ planName: "Basic", monthlyAllowance: 1_000, used: 0, remaining: 1_000 });
  });

  it("unknown user, or another account's user → 404 USER_NOT_FOUND", async () => {
    const a = await createMeteredAccount(app, { account: {}, user: {}, users: ["alice"] });
    const b = await createTestAccount(app);
    expectProblem(await getUserUsage(a.apiKey, "nobody"), 404, "USER_NOT_FOUND");
    expectProblem(await getUserUsage(b.apiKey, "alice"), 404, "USER_NOT_FOUND");
  });

  it("a malformed month → 400 VALIDATION_ERROR", async () => {
    const acct = await createMeteredAccount(app, { account: {}, user: {}, users: ["alice"] });
    for (const month of MALFORMED_MONTHS) {
      expectProblem(await getUserUsage(acct.apiKey, "alice", { month }), 400, "VALIDATION_ERROR");
    }
  });
});
