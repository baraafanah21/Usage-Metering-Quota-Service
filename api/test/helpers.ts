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
export function setupTestApp(): { pool: Pool; app: Express } {
  const pool = createPool({ connectionString: config.DATABASE_URL, max: 5 }, logger);
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

/** Asserts the response is an application/problem+json error with the given status and code. */
export function expectProblem(res: request.Response, status: number, code: string): void {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
  expect(res.body).toMatchObject({ status, code, requestId: res.headers["x-request-id"] });
}
