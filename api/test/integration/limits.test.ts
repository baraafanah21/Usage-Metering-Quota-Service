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
let account: TestAccount;

beforeEach(async () => {
  account = await createTestAccount(app);
});

const limits = (externalId: string) =>
  request(app).get(`/v1/users/${externalId}/limits`).set("X-API-Key", account.apiKey);

const CURRENT_MONTH = "date_trunc('month', now() AT TIME ZONE 'UTC')::date";

async function userId(externalId: string): Promise<string> {
  const { rows } = await pool.query("SELECT id FROM users WHERE account_id = $1 AND external_id = $2", [
    account.id,
    externalId,
  ]);
  return rows[0].id;
}

/** Counters only change through consume (Phase 3b); write them directly for now. */
async function setUsage(externalId: string, opts: { user?: number; account?: number; month?: string }) {
  const month = opts.month ? `'${opts.month}'::date` : CURRENT_MONTH;
  if (opts.account !== undefined) {
    await pool.query(
      `INSERT INTO account_monthly_usage (account_id, month, used) VALUES ($1, ${month}, $2)`,
      [account.id, opts.account],
    );
  }
  if (opts.user !== undefined) {
    await pool.query(
      `INSERT INTO user_monthly_usage (user_id, account_id, month, used) VALUES ($1, $2, ${month}, $3)`,
      [await userId(externalId), account.id, opts.user],
    );
  }
}

function utcMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

describe("GET /v1/users/:externalId/limits", () => {
  it("with no usage, remaining equals each plan's monthly allowance", async () => {
    await createTestUser(app, account.apiKey, { externalId: "alice" });

    const res = await limits("alice");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      month: utcMonth(),
      account: {
        planId: PLAN_IDS.starter,
        planName: "Starter",
        planVersion: 1,
        monthlyAllowance: 10_000,
        maxUnitsPerRequest: 100,
        used: 0,
        remaining: 10_000,
      },
      user: {
        planId: PLAN_IDS.basic,
        planName: "Basic",
        planVersion: 1,
        monthlyAllowance: 1_000,
        maxUnitsPerRequest: 20,
        used: 0,
        remaining: 1_000,
      },
    });
  });

  it("reads used from the counters and clamps remaining at 0 when over the allowance", async () => {
    await createTestUser(app, account.apiKey, { externalId: "alice" });
    await setUsage("alice", { account: 4_210, user: 1_500 }); // over Basic's 1,000

    const res = await limits("alice");
    expect(res.body.account).toMatchObject({ used: 4_210, remaining: 5_790 });
    expect(res.body.user).toMatchObject({ used: 1_500, remaining: 0 });
  });

  it("ignores counters from other months", async () => {
    await createTestUser(app, account.apiKey, { externalId: "alice" });
    await setUsage("alice", { account: 9_000, user: 900, month: "2020-01-01" });

    const res = await limits("alice");
    expect(res.body.account.used).toBe(0);
    expect(res.body.user.used).toBe(0);
  });

  it("switching the user's plan keeps used and recomputes remaining from the new plan", async () => {
    await createTestUser(app, account.apiKey, { externalId: "alice" });
    await setUsage("alice", { account: 1_200, user: 1_200 });
    expect((await limits("alice")).body.user).toMatchObject({ used: 1_200, remaining: 0 });

    await request(app)
      .put("/v1/users/alice/plan")
      .set("X-API-Key", account.apiKey)
      .send({ planId: PLAN_IDS.premium })
      .expect(200);

    const res = await limits("alice");
    expect(res.body.user).toMatchObject({ planName: "Premium", used: 1_200, remaining: 3_800 });
    expect(res.body.account).toMatchObject({ used: 1_200, remaining: 8_800 });
  });

  it("shows null limits and null remaining for rules a custom plan omits", async () => {
    const plan = await createCustomPlan(app, account.apiKey, { scope: "user", rules: { maxUnitsPerRequest: 5 } });
    await createTestUser(app, account.apiKey, { externalId: "free", planId: plan.id });

    const res = await limits("free");
    expect(res.body.user).toMatchObject({
      planId: plan.id,
      monthlyAllowance: null,
      maxUnitsPerRequest: 5,
      used: 0,
      remaining: null,
    });
  });

  it("reflects a PATCH to the account's custom plan (new limit and version)", async () => {
    const plan = await createCustomPlan(app, account.apiKey, { scope: "account", rules: { monthlyAllowance: 60 } });
    await request(app).put("/v1/account/plan").set("X-API-Key", account.apiKey).send({ planId: plan.id }).expect(200);
    await createTestUser(app, account.apiKey, { externalId: "alice" });
    await setUsage("alice", { account: 55, user: 55 });
    expect((await limits("alice")).body.account).toMatchObject({ planVersion: 1, remaining: 5 });

    await request(app)
      .patch(`/v1/plans/${plan.id}`)
      .set("X-API-Key", account.apiKey)
      .send({ rules: { monthlyAllowance: 200 } })
      .expect(200);

    expect((await limits("alice")).body.account).toMatchObject({
      planVersion: 2,
      monthlyAllowance: 200,
      used: 55,
      remaining: 145,
    });
  });

  it("404 USER_NOT_FOUND for an unknown user", async () => {
    expectProblem(await limits("nobody"), 404, "USER_NOT_FOUND");
  });
});

describe("GET /v1/account current month", () => {
  it("includes used and remaining for the current month", async () => {
    await createTestUser(app, account.apiKey, { externalId: "alice" });
    const get = () => request(app).get("/v1/account").set("X-API-Key", account.apiKey);

    expect((await get()).body.currentMonth).toEqual({ month: utcMonth(), used: 0, remaining: 10_000 });

    await setUsage("alice", { account: 10_400 });
    expect((await get()).body.currentMonth).toEqual({ month: utcMonth(), used: 10_400, remaining: 0 });
  });
});
