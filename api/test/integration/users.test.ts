import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { PLAN_IDS } from "../../src/db/seed.js";
import {
  createCustomPlan,
  createTestAccount,
  createTestUser,
  expectProblem,
  setupTestApp,
  type TestAccount,
} from "../helpers.js";

const { pool, app } = setupTestApp();
let a: TestAccount;
let b: TestAccount;

beforeEach(async () => {
  [a, b] = await Promise.all([createTestAccount(app), createTestAccount(app)]);
});

const api = (key: string) => ({
  create: (body: unknown) => request(app).post("/v1/users").set("X-API-Key", key).send(body as object),
  list: (query = "") => request(app).get(`/v1/users${query}`).set("X-API-Key", key),
  get: (id: string) => request(app).get(`/v1/users/${encodeURIComponent(id)}`).set("X-API-Key", key),
  assign: (id: string, planId: unknown) =>
    request(app).put(`/v1/users/${encodeURIComponent(id)}/plan`).set("X-API-Key", key).send({ planId }),
  limits: (id: string) => request(app).get(`/v1/users/${encodeURIComponent(id)}/limits`).set("X-API-Key", key),
});

describe("POST /v1/users", () => {
  it("registers a user on Basic by default (201 + Location)", async () => {
    const res = await api(a.apiKey).create({ externalId: "alice" });
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe("/v1/users/alice");
    expect(res.body).toMatchObject({
      externalId: "alice",
      plan: { id: PLAN_IDS.basic, name: "Basic", scope: "user", predefined: true },
    });
  });

  it("accepts an explicit predefined or own custom user plan", async () => {
    const custom = await createCustomPlan(app, a.apiKey, { scope: "user", rules: { monthlyAllowance: 5 } });
    expect((await api(a.apiKey).create({ externalId: "bob", planId: PLAN_IDS.premium })).body.plan.name).toBe("Premium");
    expect((await api(a.apiKey).create({ externalId: "carol", planId: custom.id })).body.plan.id).toBe(custom.id);
  });

  it("accepts every allowed externalId character", async () => {
    const id = "user.name_01:team@example-co";
    expect((await api(a.apiKey).create({ externalId: id })).status).toBe(201);
    expect((await api(a.apiKey).get(id)).body.externalId).toBe(id);
  });

  it("400 INVALID_PLAN_SCOPE for an account-scope plan", async () => {
    expectProblem(await api(a.apiKey).create({ externalId: "x", planId: PLAN_IDS.starter }), 400, "INVALID_PLAN_SCOPE");
  });

  it("404 PLAN_NOT_FOUND for another account's user plan, and nothing is created", async () => {
    const theirs = await createCustomPlan(app, b.apiKey, { scope: "user" });
    expectProblem(await api(a.apiKey).create({ externalId: "x", planId: theirs.id }), 404, "PLAN_NOT_FOUND");
    expectProblem(await api(a.apiKey).get("x"), 404, "USER_NOT_FOUND");
  });

  it("409 USER_ALREADY_EXISTS for a duplicate in the same account; another account may reuse it", async () => {
    expect((await api(a.apiKey).create({ externalId: "alice" })).status).toBe(201);
    expect((await api(b.apiKey).create({ externalId: "alice" })).status).toBe(201);
    expectProblem(await api(a.apiKey).create({ externalId: "alice" }), 409, "USER_ALREADY_EXISTS");
  });

  it("externalId is case-sensitive (it is the caller's identifier, compared exactly)", async () => {
    expect((await api(a.apiKey).create({ externalId: "Alice" })).status).toBe(201);
    expect((await api(a.apiKey).create({ externalId: "alice" })).status).toBe(201);
  });

  it("400 VALIDATION_ERROR for bad externalIds and unknown fields", async () => {
    for (const externalId of ["", "has space", "slash/inside", "ü", "x".repeat(201), 42]) {
      const res = await api(a.apiKey).create({ externalId });
      expectProblem(res, 400, "VALIDATION_ERROR");
      expect(res.body.errors[0].path).toBe("body.externalId");
    }
    const res = await api(a.apiKey).create({ externalId: "ok", accountId: b.id });
    expectProblem(res, 400, "VALIDATION_ERROR");
    expect(res.body.errors[0].path).toBe("body.accountId");
  });
});

describe("GET /v1/users/:externalId", () => {
  it("returns the user and its plan", async () => {
    await createTestUser(app, a.apiKey, { externalId: "bob", planId: PLAN_IDS.premium });
    const res = await api(a.apiKey).get("bob");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      externalId: "bob",
      createdAt: expect.any(String),
      plan: expect.objectContaining({ id: PLAN_IDS.premium, rules: { monthlyAllowance: 5_000, maxUnitsPerRequest: 100 } }),
    });
  });

  it("404 USER_NOT_FOUND for an unknown user", async () => {
    expectProblem(await api(a.apiKey).get("nobody"), 404, "USER_NOT_FOUND");
  });

  it("400 VALIDATION_ERROR for a malformed externalId in the path", async () => {
    expectProblem(await api(a.apiKey).get("bad id"), 400, "VALIDATION_ERROR");
  });
});

describe("PUT /v1/users/:externalId/plan", () => {
  it("switches the plan", async () => {
    await createTestUser(app, a.apiKey, { externalId: "alice" });
    const res = await api(a.apiKey).assign("alice", PLAN_IDS.premium);
    expect(res.status).toBe(200);
    expect(res.body.plan.id).toBe(PLAN_IDS.premium);
    expect((await api(a.apiKey).get("alice")).body.plan.id).toBe(PLAN_IDS.premium);
  });

  it("applies the same plan rules as create, and leaves the plan unchanged on error", async () => {
    await createTestUser(app, a.apiKey, { externalId: "alice" });
    const theirs = await createCustomPlan(app, b.apiKey, { scope: "user" });
    expectProblem(await api(a.apiKey).assign("alice", PLAN_IDS.pro), 400, "INVALID_PLAN_SCOPE");
    expectProblem(await api(a.apiKey).assign("alice", theirs.id), 404, "PLAN_NOT_FOUND");
    expectProblem(await api(a.apiKey).assign("alice", crypto.randomUUID()), 404, "PLAN_NOT_FOUND");
    expectProblem(await api(a.apiKey).assign("alice", "nope"), 400, "VALIDATION_ERROR");
    expect((await api(a.apiKey).get("alice")).body.plan.id).toBe(PLAN_IDS.basic);
  });

  it("404 USER_NOT_FOUND for an unknown user, even with a valid plan", async () => {
    expectProblem(await api(a.apiKey).assign("ghost", PLAN_IDS.premium), 404, "USER_NOT_FOUND");
  });
});

describe("tenant isolation for users", () => {
  it("account B cannot GET, assign a plan to, or read limits of A's user; nothing changes", async () => {
    await createTestUser(app, a.apiKey, { externalId: "alice" });

    expectProblem(await api(b.apiKey).get("alice"), 404, "USER_NOT_FOUND");
    expectProblem(await api(b.apiKey).assign("alice", PLAN_IDS.premium), 404, "USER_NOT_FOUND");
    expectProblem(await api(b.apiKey).limits("alice"), 404, "USER_NOT_FOUND");

    expect((await api(a.apiKey).get("alice")).body.plan.id).toBe(PLAN_IDS.basic);
    expect((await api(b.apiKey).list()).body.users).toEqual([]);
  });
});

describe("GET /v1/users (keyset pagination)", () => {
  async function collectPages(key: string, limit: number) {
    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await api(key).list(query);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      pages.push(res.body.users.map((u: { externalId: string }) => u.externalId));
      cursor = res.body.nextCursor;
    } while (cursor !== null);
    return pages;
  }

  it("45 users at limit 20 → pages of 20/20/5, each user exactly once, null cursor at the end", async () => {
    const ids = Array.from({ length: 45 }, (_, i) => `u${String(i).padStart(2, "0")}`);
    await Promise.all(ids.map((externalId) => createTestUser(app, a.apiKey, { externalId })));
    await createTestUser(app, b.apiKey, { externalId: "belongs-to-b" });

    const pages = await collectPages(a.apiKey, 20);
    expect(pages.map((p) => p.length)).toEqual([20, 20, 5]);
    expect(pages.flat().sort()).toEqual(ids);
  });

  it("orders by (created_at, id) and handles identical created_at via the id tie-break", async () => {
    // One INSERT statement → one transaction → every row gets the same now().
    await pool.query(
      `INSERT INTO users (account_id, external_id, plan_id)
       SELECT $1, 'same-' || g, $2 FROM generate_series(1, 7) g`,
      [a.id, PLAN_IDS.basic],
    );
    const { rows } = await pool.query(
      "SELECT external_id FROM users WHERE account_id = $1 ORDER BY created_at, id",
      [a.id],
    );
    const pages = await collectPages(a.apiKey, 3);
    expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);
    expect(pages.flat()).toEqual(rows.map((r) => r.external_id));
  });

  it("returns the plan id and name with each user", async () => {
    await createTestUser(app, a.apiKey, { externalId: "bob", planId: PLAN_IDS.premium });
    const res = await api(a.apiKey).list();
    expect(res.body).toEqual({
      users: [{ externalId: "bob", createdAt: expect.any(String), plan: { id: PLAN_IDS.premium, name: "Premium" } }],
      nextCursor: null,
    });
  });

  it("defaults to 20 per page", async () => {
    await Promise.all(
      Array.from({ length: 21 }, (_, i) => createTestUser(app, a.apiKey, { externalId: `d${i}` })),
    );
    const res = await api(a.apiKey).list();
    expect(res.body.users).toHaveLength(20);
    expect(res.body.nextCursor).toEqual(expect.any(String));
  });

  it("400 INVALID_CURSOR for a cursor we did not issue", async () => {
    const forged = Buffer.from(JSON.stringify(["yesterday", "x"])).toString("base64url");
    for (const cursor of ["garbage", forged, Buffer.from("{}").toString("base64url")]) {
      expectProblem(await api(a.apiKey).list(`?cursor=${cursor}`), 400, "INVALID_CURSOR");
    }
  });

  it("400 VALIDATION_ERROR for a limit outside 1-100", async () => {
    for (const limit of ["0", "101", "abc", "1.5"]) {
      expectProblem(await api(a.apiKey).list(`?limit=${limit}`), 400, "VALIDATION_ERROR");
    }
  });
});
