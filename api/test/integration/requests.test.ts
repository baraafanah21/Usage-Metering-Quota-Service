import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  consumeAs,
  createMeteredAccount,
  createTestAccount,
  currentMonth,
  expectProblem,
  type MeteredAccount,
  seedLastMonth,
  setupTestApp,
} from "../helpers.js";

const { pool, app } = setupTestApp();

const history = (apiKey: string, query: Record<string, string | number> = {}) =>
  request(app).get("/v1/requests").query(query).set("X-API-Key", apiKey);

const ids = (res: request.Response) => res.body.requests.map((r: { requestId: string }) => r.requestId);

/**
 * Account with alice and bob, and five sequential decisions r1..r5 (two rejected). `before`
 * runs first, so rows it writes get lower ledger ids, as older history really has.
 */
async function withFiveRequests(
  before?: (acct: MeteredAccount) => Promise<void>,
): Promise<MeteredAccount & { responses: request.Response[] }> {
  const acct = await createMeteredAccount(app, {
    account: { monthlyAllowance: 1_000 },
    user: { maxUnitsPerRequest: 20 },
    users: ["alice", "bob"],
  });
  await before?.(acct);
  const calls: [string, string, number][] = [
    ["r1", "alice", 10], // accepted
    ["r2", "bob", 25], // rejected: user max_units_per_request
    ["r3", "alice", 5], // accepted
    ["r4", "bob", 3], // accepted
    ["r5", "alice", 30], // rejected: user max_units_per_request
  ];
  const responses = [];
  for (const [requestId, userId, units] of calls) {
    const res = await consumeAs(app, acct.apiKey, { userId, units, requestId });
    expect(res.status).toBe(200);
    responses.push(res);
  }
  return { ...acct, responses };
}

describe("GET /v1/requests", () => {
  it("lists the account's decisions newest first, rejected ones with their reason", async () => {
    const acct = await withFiveRequests();
    const res = await history(acct.apiKey);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(["r5", "r4", "r3", "r2", "r1"]);
    expect(res.body.nextCursor).toBeNull();

    const month = await currentMonth(pool);
    const [r5, r4] = res.body.requests;
    expect(r5).toEqual({
      requestId: "r5",
      userId: "alice",
      units: 30,
      decision: "rejected",
      reason: { scope: "user", rule: "max_units_per_request" },
      month,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      accountPlan: { id: acct.accountPlanId, version: 1 },
      userPlan: { id: acct.userPlanId, version: 1 },
    });
    expect(r4).toMatchObject({ requestId: "r4", userId: "bob", units: 3, decision: "accepted", reason: null });
    // Newest first also by time.
    const times = res.body.requests.map((r: { createdAt: string }) => Date.parse(r.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("filters by userId, month and decision, alone and combined", async () => {
    let lastMonth = "";
    const acct = await withFiveRequests(async (a) => {
      lastMonth = await seedLastMonth(pool, a.id, [
        { externalId: "alice", units: 4, decision: "accepted", requestId: "old-1" },
        { externalId: "bob", units: 9, decision: "rejected", requestId: "old-2" },
      ]);
    });
    const month = await currentMonth(pool);

    const cases: [Record<string, string>, string[]][] = [
      [{}, ["r5", "r4", "r3", "r2", "r1", "old-2", "old-1"]],
      [{ userId: "alice" }, ["r5", "r3", "r1", "old-1"]],
      [{ month }, ["r5", "r4", "r3", "r2", "r1"]],
      [{ month: lastMonth }, ["old-2", "old-1"]],
      [{ month: "2001-01" }, []],
      [{ decision: "rejected" }, ["r5", "r2", "old-2"]],
      [{ decision: "accepted" }, ["r4", "r3", "r1", "old-1"]],
      [{ userId: "alice", decision: "accepted" }, ["r3", "r1", "old-1"]],
      [{ userId: "bob", month }, ["r4", "r2"]],
      [{ month: lastMonth, decision: "rejected" }, ["old-2"]],
      [{ userId: "bob", month: lastMonth, decision: "rejected" }, ["old-2"]],
      [{ userId: "alice", month: lastMonth, decision: "rejected" }, []],
    ];
    for (const [query, expected] of cases) {
      const res = await history(acct.apiKey, query);
      expect(res.status, JSON.stringify(query)).toBe(200);
      expect(ids(res), JSON.stringify(query)).toEqual(expected);
    }

    const old = await history(acct.apiKey, { month: lastMonth });
    expect(old.body.requests[0]).toMatchObject({ requestId: "old-2", month: lastMonth, reason: { scope: "user" } });
  });

  it("?include=evaluation adds the stored snapshot: the response as returned at decision time", async () => {
    const acct = await withFiveRequests();
    // Change the plan afterwards: the snapshot must still show what was applied then.
    await request(app)
      .patch(`/v1/plans/${acct.userPlanId}`)
      .set("X-API-Key", acct.apiKey)
      .send({ rules: { maxUnitsPerRequest: 50 } })
      .expect(200);

    const plain = await history(acct.apiKey, { limit: 1 });
    expect(plain.body.requests[0]).not.toHaveProperty("evaluation");

    const res = await history(acct.apiKey, { include: "evaluation" });
    const byId = new Map(res.body.requests.map((r: { requestId: string }) => [r.requestId, r]));
    for (const original of acct.responses) {
      const item = byId.get(original.body.requestId) as { evaluation: unknown };
      expect(item.evaluation).toEqual(original.body);
      // Same key order as the consume response, not jsonb's.
      expect(JSON.stringify(item.evaluation)).toBe(JSON.stringify(original.body));
    }
    expect(byId.get("r5")).toMatchObject({ evaluation: { user: { maxUnitsPerRequest: 20, planVersion: 1 } } });
  });

  it("pagination over 45 requests returns each exactly once, newest first", async () => {
    const acct = await createMeteredAccount(app, { account: {}, user: {}, users: ["alice", "bob"] });
    const sent: string[] = [];
    for (let i = 0; i < 45; i++) {
      const requestId = `p-${i}`;
      await consumeAs(app, acct.apiKey, { userId: i % 3 ? "alice" : "bob", units: 1, requestId }).expect(200);
      sent.push(requestId);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await history(acct.apiKey, { limit: 10, ...(cursor && { cursor }) });
      expect(res.status).toBe(200);
      seen.push(...ids(res));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(5);
    expect(seen).toEqual([...sent].reverse());

    // Paging with a filter keeps the filter's rows only, also each exactly once.
    const bobs: string[] = [];
    cursor = null;
    do {
      const res = await history(acct.apiKey, { userId: "bob", limit: 4, ...(cursor && { cursor }) });
      bobs.push(...ids(res));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(bobs).toEqual(sent.filter((_, i) => i % 3 === 0).reverse());
  });

  it("never shows another account's requests, even with the same requestIds and externalIds", async () => {
    const a = await withFiveRequests();
    const b = await createMeteredAccount(app, { account: {}, user: {}, users: ["alice"] });
    for (const requestId of ["r1", "r2", "r9"]) {
      await consumeAs(app, b.apiKey, { userId: "alice", units: 7, requestId }).expect(200);
    }

    const resA = await history(a.apiKey, { limit: 100 });
    expect(ids(resA)).toEqual(["r5", "r4", "r3", "r2", "r1"]);
    expect(resA.body.requests.some((r: { units: number }) => r.units === 7)).toBe(false);

    const resB = await history(b.apiKey, { userId: "alice" });
    expect(ids(resB)).toEqual(["r9", "r2", "r1"]);
    expect(resB.body.requests.every((r: { units: number }) => r.units === 7)).toBe(true);
  });

  it("an unknown userId filter, or another account's user → 404 USER_NOT_FOUND", async () => {
    const a = await createMeteredAccount(app, { account: {}, user: {}, users: ["alice"] });
    const b = await createMeteredAccount(app, { account: {}, user: {}, users: ["zed"] });
    expectProblem(await history(a.apiKey, { userId: "nobody" }), 404, "USER_NOT_FOUND");
    expectProblem(await history(a.apiKey, { userId: "zed" }), 404, "USER_NOT_FOUND");
    expectProblem(await history(b.apiKey, { userId: "alice" }), 404, "USER_NOT_FOUND");
  });

  it("validates the query", async () => {
    const acct = await createTestAccount(app);
    const bad: Record<string, string | number>[] = [
      { decision: "maybe" },
      { month: "2026-13" },
      { limit: 0 },
      { limit: 101 },
      { include: "everything" },
      { userId: "has space" },
    ];
    for (const query of bad) expectProblem(await history(acct.apiKey, query), 400, "VALIDATION_ERROR");

    const userCursor = Buffer.from(JSON.stringify(["2026-10-01T00:00:00.000000Z", crypto.randomUUID()])).toString(
      "base64url",
    );
    for (const cursor of ["garbage", userCursor, Buffer.from('["0"]').toString("base64url")]) {
      expectProblem(await history(acct.apiKey, { cursor }), 400, "INVALID_CURSOR");
    }
  });

  it("an account with no requests → empty page", async () => {
    const acct = await createTestAccount(app);
    const res = await history(acct.apiKey);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requests: [], nextCursor: null });
  });
});
