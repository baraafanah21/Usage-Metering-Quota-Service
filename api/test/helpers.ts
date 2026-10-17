import type { Express } from "express";
import type { Pool } from "pg";
import { pino } from "pino";
import request from "supertest";
import { afterAll, expect } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";

export const logger = pino({ level: "silent" });
export const config = loadConfig();
export const ADMIN_KEY = config.ADMIN_API_KEY;

/** A pool and app for one test file, closed automatically after the file. */
export function setupTestApp({ poolMax = 5 }: { poolMax?: number } = {}): { pool: Pool; app: Express } {
  const pool = createPool({ connectionString: config.DATABASE_URL, max: poolMax }, logger);
  afterAll(() => pool.end());
  return {
    pool,
    app: createApp({ pool, logger, adminApiKey: ADMIN_KEY, apiKeyCacheTtlMs: config.API_KEY_CACHE_TTL_MS }),
  };
}

export interface TestAccount {
  id: string;
  name: string;
  apiKey: string;
}

/** A brand-new account (unique name), so tests never share or clean up data. */
export async function createTestAccount(
  app: Express,
  body: { name?: string; planId?: string } = {},
): Promise<TestAccount> {
  const name = body.name ?? `test-${crypto.randomUUID()}`;
  const res = await request(app)
    .post("/v1/admin/accounts")
    .set("X-Admin-Key", ADMIN_KEY)
    .send({ ...body, name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.account.id, name, apiKey: res.body.apiKey.key };
}

export interface CustomPlanInput {
  name?: string;
  scope: "account" | "user";
  rules?: { monthlyAllowance?: number; maxUnitsPerRequest?: number };
}

/** Creates a custom plan owned by the key's account (unique name unless given). Returns its JSON. */
export async function createCustomPlan(
  app: Express,
  apiKey: string,
  input: CustomPlanInput,
): Promise<{ id: string; name: string; version: number; [key: string]: unknown }> {
  const res = await request(app)
    .post("/v1/plans")
    .set("X-API-Key", apiKey)
    .send({ name: input.name ?? `plan-${crypto.randomUUID()}`, scope: input.scope, rules: input.rules ?? {} });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

/** Registers a user under the key's account. Returns the response body. */
export async function createTestUser(
  app: Express,
  apiKey: string,
  body: { externalId: string; planId?: string },
): Promise<{ externalId: string; plan: { id: string; name: string } }> {
  const res = await request(app).post("/v1/users").set("X-API-Key", apiKey).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

/** Asserts the response is an application/problem+json error with the given status and code. */
export function expectProblem(res: request.Response, status: number, code: string): void {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  expect(res.body).toMatchObject({ status, code, requestId: res.headers["x-request-id"] });
}

export interface Rules {
  monthlyAllowance?: number;
  maxUnitsPerRequest?: number;
}

export interface MeteredAccount extends TestAccount {
  accountPlanId: string;
  userPlanId: string;
}

/**
 * A fresh account on a custom account plan with exact limits, and users on one custom user
 * plan, so a test controls every number. Omitted rules are unlimited.
 */
export async function createMeteredAccount(
  app: Express,
  opts: { account: Rules; user: Rules; users: string[] },
): Promise<MeteredAccount> {
  const account = await createTestAccount(app);
  const accountPlan = await createCustomPlan(app, account.apiKey, { scope: "account", rules: opts.account });
  const userPlan = await createCustomPlan(app, account.apiKey, { scope: "user", rules: opts.user });
  const res = await request(app)
    .put("/v1/account/plan")
    .set("X-API-Key", account.apiKey)
    .send({ planId: accountPlan.id });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  for (const externalId of opts.users) {
    await createTestUser(app, account.apiKey, { externalId, planId: userPlan.id });
  }
  return { ...account, accountPlanId: accountPlan.id, userPlanId: userPlan.id };
}

/**
 * Writes ledger rows for LAST month straight into the database (the API only ever writes the
 * current month), dated the 2nd of that month, against each user's and the account's current
 * plan. Then sets both counters to the accepted totals, so invariant I5 holds for that month
 * too. Returns the month as "YYYY-MM".
 */
export async function seedLastMonth(
  pool: Pool,
  accountId: string,
  rows: { externalId: string; units: number; decision: "accepted" | "rejected"; requestId: string }[],
): Promise<string> {
  const month = "(date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month')::date";
  for (const row of rows) {
    const rejected = row.decision === "rejected";
    const { rowCount } = await pool.query(
      `INSERT INTO usage_requests
         (account_id, user_id, request_id, units, decision, reject_scope, reject_rule, month,
          account_plan_id, account_plan_version, user_plan_id, user_plan_version, evaluation, created_at)
       SELECT $1, u.id, $3, $4, $5, $6, $7, ${month},
              ap.id, ap.version, up.id, up.version, '{"seeded": true}', ${month} + interval '1 day'
       FROM users u
       JOIN accounts a ON a.id = u.account_id
       JOIN plans ap ON ap.id = a.plan_id
       JOIN plans up ON up.id = u.plan_id
       WHERE u.account_id = $1 AND u.external_id = $2`,
      [
        accountId,
        row.externalId,
        row.requestId,
        row.units,
        row.decision,
        rejected ? "user" : null,
        rejected ? "monthly_allowance" : null,
      ],
    );
    expect(rowCount, `seed ${row.requestId}`).toBe(1);
  }
  await pool.query(
    `INSERT INTO account_monthly_usage (account_id, month, used)
     SELECT account_id, month, sum(units) FROM usage_requests
     WHERE account_id = $1 AND month = ${month} AND decision = 'accepted' GROUP BY account_id, month
     ON CONFLICT (account_id, month) DO UPDATE SET used = EXCLUDED.used`,
    [accountId],
  );
  await pool.query(
    `INSERT INTO user_monthly_usage (user_id, account_id, month, used)
     SELECT user_id, account_id, month, sum(units) FROM usage_requests
     WHERE account_id = $1 AND month = ${month} AND decision = 'accepted' GROUP BY user_id, account_id, month
     ON CONFLICT (user_id, month) DO UPDATE SET used = EXCLUDED.used`,
    [accountId],
  );
  const { rows: m } = await pool.query<{ month: string }>(`SELECT to_char(${month}, 'YYYY-MM') AS month`);
  return m[0]!.month;
}

/** The current UTC month as "YYYY-MM", by the database clock (the one the API uses). */
export async function currentMonth(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ month: string }>(
    "SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC'), 'YYYY-MM') AS month",
  );
  return rows[0]!.month;
}

/** POST /v1/consume as the given account. */
export function consumeAs(app: Express, apiKey: string, body: { userId: string; units: number; requestId?: string }) {
  return request(app)
    .post("/v1/consume")
    .set("X-API-Key", apiKey)
    .send({ requestId: body.requestId ?? crypto.randomUUID(), ...body });
}
