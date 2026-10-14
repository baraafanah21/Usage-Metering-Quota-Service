import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { PLAN_IDS } from "../../src/db/seed.js";
import { createTestAccount, expectProblem, setupTestApp, type TestAccount } from "../helpers.js";

const { app } = setupTestApp();
let account: TestAccount;

beforeEach(async () => {
  account = await createTestAccount(app);
});

const getAccount = (key = account.apiKey) => request(app).get("/v1/account").set("X-API-Key", key);
const putPlan = (body: unknown, key = account.apiKey) =>
  request(app).put("/v1/account/plan").set("X-API-Key", key).send(body as object);

describe("GET /v1/account", () => {
  it("returns the account and its current plan with rules", async () => {
    const res = await getAccount();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: account.id,
      name: account.name,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      plan: {
        id: PLAN_IDS.starter,
        name: "Starter",
        scope: "account",
        version: 1,
        predefined: true,
        rules: { monthlyAllowance: 10_000, maxUnitsPerRequest: 100 },
      },
    });
  });
});

describe("PUT /v1/account/plan", () => {
  it("switches Starter → Pro", async () => {
    const res = await putPlan({ planId: PLAN_IDS.pro });
    expect(res.status).toBe(200);
    expect(res.body.plan).toMatchObject({
      id: PLAN_IDS.pro,
      name: "Pro",
      rules: { monthlyAllowance: 100_000, maxUnitsPerRequest: 500 },
    });
    expect((await getAccount()).body.plan.id).toBe(PLAN_IDS.pro);
  });

  it("changes only the caller's account", async () => {
    const other = await createTestAccount(app);
    await putPlan({ planId: PLAN_IDS.pro });
    expect((await getAccount(other.apiKey)).body.plan.id).toBe(PLAN_IDS.starter);
  });

  it("400 INVALID_PLAN_SCOPE for a user-scope plan, plan unchanged", async () => {
    expectProblem(await putPlan({ planId: PLAN_IDS.premium }), 400, "INVALID_PLAN_SCOPE");
    expect((await getAccount()).body.plan.id).toBe(PLAN_IDS.starter);
  });

  it("404 PLAN_NOT_FOUND for an unknown plan, plan unchanged", async () => {
    expectProblem(await putPlan({ planId: crypto.randomUUID() }), 404, "PLAN_NOT_FOUND");
    expect((await getAccount()).body.plan.id).toBe(PLAN_IDS.starter);
  });

  it("400 VALIDATION_ERROR for a bad body", async () => {
    const res = await putPlan({ planId: 42, extra: true });
    expectProblem(res, 400, "VALIDATION_ERROR");
    const paths = res.body.errors.map((e: { path: string }) => e.path).sort();
    expect(paths).toEqual(["body.extra", "body.planId"]);
  });
});
