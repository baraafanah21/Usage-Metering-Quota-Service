import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { PLAN_IDS } from "../../src/db/seed.js";
import {
  createCustomPlan,
  createTestAccount,
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
  list: (query = "") => request(app).get(`/v1/plans${query}`).set("X-API-Key", key),
  create: (body: unknown) => request(app).post("/v1/plans").set("X-API-Key", key).send(body as object),
  get: (id: string) => request(app).get(`/v1/plans/${id}`).set("X-API-Key", key),
  patch: (id: string, body: unknown) =>
    request(app).patch(`/v1/plans/${id}`).set("X-API-Key", key).send(body as object),
  assign: (planId: string) => request(app).put("/v1/account/plan").set("X-API-Key", key).send({ planId }),
});

async function storedPlan(planId: string) {
  const { rows } = await pool.query(
    `SELECT p.name, p.version, p.updated_at,
            coalesce(json_object_agg(r.type, r."limit") FILTER (WHERE r.type IS NOT NULL), '{}') AS rules
     FROM plans p LEFT JOIN plan_rules r ON r.plan_id = p.id
     WHERE p.id = $1 GROUP BY p.id`,
    [planId],
  );
  return rows[0];
}

const PREDEFINED_IDS = [PLAN_IDS.starter, PLAN_IDS.pro, PLAN_IDS.basic, PLAN_IDS.premium];

describe("POST /v1/plans", () => {
  it("creates a custom account plan with its rules (201)", async () => {
    const res = await api(a.apiKey).create({
      name: "  Team  ",
      scope: "account",
      rules: { monthlyAllowance: 60, maxUnitsPerRequest: 50 },
    });
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/v1/plans/${res.body.id}`);
    expect(res.body).toMatchObject({
      name: "Team",
      scope: "account",
      predefined: false,
      version: 1,
      rules: { monthlyAllowance: 60, maxUnitsPerRequest: 50 },
    });
    expect(await storedPlan(res.body.id)).toMatchObject({
      rules: { monthly_allowance: 60, max_units_per_request: 50 },
    });
  });

  it("a missing rule means unlimited, and 0 is a valid limit", async () => {
    const res = await api(a.apiKey).create({ name: "Zero", scope: "user", rules: { monthlyAllowance: 0 } });
    expect(res.status).toBe(201);
    expect(res.body.rules).toEqual({ monthlyAllowance: 0, maxUnitsPerRequest: null });
  });

  it("409 PLAN_NAME_TAKEN for the same name in the same scope, case-insensitively", async () => {
    await createCustomPlan(app, a.apiKey, { name: "Gold", scope: "user" });
    const res = await api(a.apiKey).create({ name: "gOLD", scope: "user", rules: {} });
    expectProblem(res, 409, "PLAN_NAME_TAKEN");
  });

  it("allows the same name in the other scope, and in another account", async () => {
    await createCustomPlan(app, a.apiKey, { name: "Gold", scope: "user" });
    expect((await api(a.apiKey).create({ name: "Gold", scope: "account", rules: {} })).status).toBe(201);
    expect((await api(b.apiKey).create({ name: "Gold", scope: "user", rules: {} })).status).toBe(201);
  });

  it("400 VALIDATION_ERROR for negative and non-integer limits, bad name and scope", async () => {
    const res = await api(a.apiKey).create({
      name: "x".repeat(101),
      scope: "team",
      rules: { monthlyAllowance: -1, maxUnitsPerRequest: 1.5 },
    });
    expectProblem(res, 400, "VALIDATION_ERROR");
    expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual([
      "body.name",
      "body.rules.maxUnitsPerRequest",
      "body.rules.monthlyAllowance",
      "body.scope",
    ]);
  });

  it("400 VALIDATION_ERROR when rules is missing", async () => {
    const res = await api(a.apiKey).create({ name: "NoRules", scope: "user" });
    expectProblem(res, 400, "VALIDATION_ERROR");
    expect(res.body.errors[0].path).toBe("body.rules");
  });
});

describe("GET /v1/plans", () => {
  it("lists predefined plans first, then only the caller's own custom plans", async () => {
    const accountPlan = await createCustomPlan(app, a.apiKey, { scope: "account" });
    const userPlan = await createCustomPlan(app, a.apiKey, { scope: "user" });
    const othersPlan = await createCustomPlan(app, b.apiKey, { scope: "user" });

    const res = await api(a.apiKey).list();
    expect(res.status).toBe(200);
    const ids = res.body.plans.map((p: { id: string }) => p.id);
    expect(ids.slice(0, 4).sort()).toEqual([...PREDEFINED_IDS].sort());
    expect(ids.slice(4)).toEqual([accountPlan.id, userPlan.id]);
    expect(ids).not.toContain(othersPlan.id);
    expect(res.body.plans[0]).toEqual({
      id: expect.any(String),
      name: expect.any(String),
      scope: expect.any(String),
      predefined: true,
      version: 1,
      rules: expect.any(Object),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("filters by scope", async () => {
    const userPlan = await createCustomPlan(app, a.apiKey, { scope: "user" });
    await createCustomPlan(app, a.apiKey, { scope: "account" });

    const res = await api(a.apiKey).list("?scope=user");
    const plans: { id: string; scope: string }[] = res.body.plans;
    expect(plans.every((p) => p.scope === "user")).toBe(true);
    expect(plans.map((p) => p.id)).toEqual([PLAN_IDS.basic, PLAN_IDS.premium, userPlan.id]);
  });

  it("400 VALIDATION_ERROR for an unknown scope", async () => {
    expectProblem(await api(a.apiKey).list("?scope=team"), 400, "VALIDATION_ERROR");
  });
});

describe("GET /v1/plans/:planId", () => {
  it("returns a predefined plan with this account's assignment counts", async () => {
    const res = await api(a.apiKey).get(PLAN_IDS.starter);
    expect(res.status).toBe(200);
    // Counts cover only this account, never other tenants on the same predefined plan.
    expect(res.body).toMatchObject({ id: PLAN_IDS.starter, predefined: true, assignments: { accounts: 1, users: 0 } });
  });

  it("counts the account and its users on a custom plan", async () => {
    const accountPlan = await createCustomPlan(app, a.apiKey, { scope: "account" });
    const userPlan = await createCustomPlan(app, a.apiKey, { scope: "user" });
    await api(a.apiKey).assign(accountPlan.id);
    // No users API until Phase 3: insert directly.
    await pool.query(
      `INSERT INTO users (account_id, external_id, plan_id) VALUES ($1, 'u1', $2), ($1, 'u2', $2)`,
      [a.id, userPlan.id],
    );

    expect((await api(a.apiKey).get(accountPlan.id)).body.assignments).toEqual({ accounts: 1, users: 0 });
    expect((await api(a.apiKey).get(userPlan.id)).body.assignments).toEqual({ accounts: 0, users: 2 });
  });

  it("404 PLAN_NOT_FOUND for an unknown id", async () => {
    expectProblem(await api(a.apiKey).get(crypto.randomUUID()), 404, "PLAN_NOT_FOUND");
  });

  it("400 VALIDATION_ERROR for a malformed id", async () => {
    expectProblem(await api(a.apiKey).get("not-a-uuid"), 400, "VALIDATION_ERROR");
  });
});

describe("PATCH /v1/plans/:planId", () => {
  it("bumps the version by exactly 1; null removes a rule; a missing key keeps it", async () => {
    const plan = await createCustomPlan(app, a.apiKey, {
      scope: "user",
      rules: { monthlyAllowance: 100, maxUnitsPerRequest: 10 },
    });
    const before = await storedPlan(plan.id);

    const res = await api(a.apiKey).patch(plan.id, { rules: { monthlyAllowance: null } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: 2,
      name: plan.name,
      rules: { monthlyAllowance: null, maxUnitsPerRequest: 10 },
    });
    const after = await storedPlan(plan.id);
    expect(after.rules).toEqual({ max_units_per_request: 10 });
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());

    const res2 = await api(a.apiKey).patch(plan.id, { name: "Renamed", rules: { monthlyAllowance: 0 } });
    expect(res2.body).toMatchObject({
      version: 3,
      name: "Renamed",
      rules: { monthlyAllowance: 0, maxUnitsPerRequest: 10 },
    });
  });

  it("concurrent PATCHes never lose a version bump", async () => {
    const plan = await createCustomPlan(app, a.apiKey, { scope: "account" });

    const pair = await Promise.all([
      api(a.apiKey).patch(plan.id, { rules: { monthlyAllowance: 1 } }),
      api(a.apiKey).patch(plan.id, { rules: { monthlyAllowance: 2 } }),
    ]);
    expect(pair.map((r) => r.status)).toEqual([200, 200]);
    expect((await storedPlan(plan.id)).version).toBe(plan.version + 2);

    const ten = await Promise.all(
      Array.from({ length: 10 }, (_, i) => api(a.apiKey).patch(plan.id, { rules: { maxUnitsPerRequest: i } })),
    );
    expect(ten.every((r) => r.status === 200)).toBe(true);
    expect((await storedPlan(plan.id)).version).toBe(plan.version + 12);
  });

  it("403 PLAN_READ_ONLY for a predefined plan, and its rules are unchanged", async () => {
    const before = await storedPlan(PLAN_IDS.starter);
    const res = await api(a.apiKey).patch(PLAN_IDS.starter, { rules: { monthlyAllowance: 1_000_000 } });
    expectProblem(res, 403, "PLAN_READ_ONLY");
    expect(await storedPlan(PLAN_IDS.starter)).toEqual(before);
  });

  it("409 PLAN_NAME_TAKEN when renaming onto an existing name; nothing changes", async () => {
    await createCustomPlan(app, a.apiKey, { name: "Taken", scope: "user" });
    const plan = await createCustomPlan(app, a.apiKey, { scope: "user", rules: { monthlyAllowance: 5 } });

    const res = await api(a.apiKey).patch(plan.id, { name: "TAKEN", rules: { monthlyAllowance: 6 } });
    expectProblem(res, 409, "PLAN_NAME_TAKEN");
    expect(await storedPlan(plan.id)).toMatchObject({ name: plan.name, version: 1, rules: { monthly_allowance: 5 } });
  });

  it("400 VALIDATION_ERROR for an empty body, empty rules, scope, or bad limits", async () => {
    const plan = await createCustomPlan(app, a.apiKey, { scope: "user" });
    const cases: [unknown, string][] = [
      [{}, "body"],
      [{ rules: {} }, "body"],
      [{ scope: "account" }, "body.scope"],
      [{ rules: { monthlyAllowance: -5 } }, "body.rules.monthlyAllowance"],
      [{ rules: { maxUnitsPerRequest: 2.5 } }, "body.rules.maxUnitsPerRequest"],
    ];
    for (const [body, path] of cases) {
      const res = await api(a.apiKey).patch(plan.id, body);
      expectProblem(res, 400, "VALIDATION_ERROR");
      expect(res.body.errors.map((e: { path: string }) => e.path)).toContain(path);
    }
    expect((await storedPlan(plan.id)).version).toBe(1);
  });
});

describe("tenant isolation for custom plans", () => {
  it("account B cannot GET, PATCH or assign account A's plan, and nothing changes", async () => {
    const plan = await createCustomPlan(app, a.apiKey, { scope: "account", rules: { monthlyAllowance: 60 } });
    const before = await storedPlan(plan.id);

    expectProblem(await api(b.apiKey).get(plan.id), 404, "PLAN_NOT_FOUND");
    expectProblem(await api(b.apiKey).patch(plan.id, { rules: { monthlyAllowance: 1 } }), 404, "PLAN_NOT_FOUND");
    expectProblem(await api(b.apiKey).assign(plan.id), 404, "PLAN_NOT_FOUND");

    expect(await storedPlan(plan.id)).toEqual(before);
    const bAccount = await request(app).get("/v1/account").set("X-API-Key", b.apiKey);
    expect(bAccount.body.plan.id).toBe(PLAN_IDS.starter);
  });
});
