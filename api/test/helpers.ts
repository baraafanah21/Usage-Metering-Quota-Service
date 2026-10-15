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
  return { pool, app: createApp({ pool, logger, adminApiKey: ADMIN_KEY }) };
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

/** POST /v1/consume as the given account. */
export function consumeAs(app: Express, apiKey: string, body: { userId: string; units: number; requestId?: string }) {
  return request(app)
    .post("/v1/consume")
    .set("X-API-Key", apiKey)
    .send({ requestId: body.requestId ?? crypto.randomUUID(), ...body });
}
