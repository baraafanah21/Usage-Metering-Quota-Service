import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { generateApiKey } from "../../src/domain/apiKeys.js";
import { ADMIN_KEY, createTestAccount, expectProblem, logger, setupTestApp, type TestAccount } from "../helpers.js";

const { pool, app } = setupTestApp();

const getAccount = (apiKey?: string) => {
  const req = request(app).get("/v1/account");
  return apiKey === undefined ? req : req.set("X-API-Key", apiKey);
};

describe("requireApiKey", () => {
  it("401 MISSING_API_KEY without the header", async () => {
    expectProblem(await getAccount(), 401, "MISSING_API_KEY");
  });

  it("401 MISSING_API_KEY for an empty header", async () => {
    expectProblem(await getAccount(""), 401, "MISSING_API_KEY");
  });

  it("401 INVALID_API_KEY for a garbage key", async () => {
    expectProblem(await getAccount("garbage"), 401, "INVALID_API_KEY");
  });

  it("401 INVALID_API_KEY for a well-formed key that was never issued", async () => {
    expectProblem(await getAccount(generateApiKey().key), 401, "INVALID_API_KEY");
  });

  it("401 INVALID_API_KEY for a revoked key", async () => {
    const account = await createTestAccount(app);
    expect((await getAccount(account.apiKey)).status).toBe(200);

    await pool.query("UPDATE api_keys SET revoked_at = now() WHERE account_id = $1", [account.id]);

    expectProblem(await getAccount(account.apiKey), 401, "INVALID_API_KEY");
  });

  it("with the API key cache on, a revoked key stops working within the TTL", async () => {
    const ttlMs = 300;
    const cachedApp = createApp({ pool, logger, adminApiKey: ADMIN_KEY, apiKeyCacheTtlMs: ttlMs });
    const account = await createTestAccount(app);
    expect((await request(cachedApp).get("/v1/account").set("X-API-Key", account.apiKey)).status).toBe(200);

    await pool.query("UPDATE api_keys SET revoked_at = now() WHERE account_id = $1", [account.id]);
    const revokedAt = Date.now();

    // The staleness window (DESIGN.md §7, §17): this instance still trusts its cached entry.
    expect((await request(cachedApp).get("/v1/account").set("X-API-Key", account.apiKey)).status).toBe(200);
    // Once the entry has expired, the key is looked up again and refused.
    await new Promise((resolve) => setTimeout(resolve, ttlMs - (Date.now() - revokedAt) + 50));
    expectProblem(await request(cachedApp).get("/v1/account").set("X-API-Key", account.apiKey), 401, "INVALID_API_KEY");
  });

  it("the admin key does not authenticate account routes", async () => {
    const res = await request(app).get("/v1/account").set("X-Admin-Key", ADMIN_KEY);
    expectProblem(res, 401, "MISSING_API_KEY");
  });

  it("unknown /v1 routes require a key before revealing anything", async () => {
    expectProblem(await request(app).get("/v1/nope"), 401, "MISSING_API_KEY");
  });
});

describe("tenant isolation", () => {
  let a: TestAccount;
  let b: TestAccount;

  beforeAll(async () => {
    [a, b] = await Promise.all([createTestAccount(app), createTestAccount(app)]);
  });

  it("each key sees only its own account", async () => {
    const resA = await getAccount(a.apiKey);
    const resB = await getAccount(b.apiKey);
    expect(resA.body).toMatchObject({ id: a.id, name: a.name });
    expect(resB.body).toMatchObject({ id: b.id, name: b.name });
  });

  it("an account id in the query or body is ignored", async () => {
    const res = await request(app)
      .get(`/v1/account?accountId=${b.id}`)
      .set("X-API-Key", a.apiKey)
      .set("Content-Type", "application/json")
      .send({ accountId: b.id });
    expect(res.body.id).toBe(a.id);
  });
});
