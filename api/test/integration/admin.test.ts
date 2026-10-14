import request from "supertest";
import { describe, expect, it } from "vitest";
import { PLAN_IDS } from "../../src/db/seed.js";
import { API_KEY_PATTERN, hashApiKey } from "../../src/domain/apiKeys.js";
import { ADMIN_KEY, expectProblem, setupTestApp } from "../helpers.js";

const { pool, app } = setupTestApp();

// adminKey null = send no X-Admin-Key header at all.
const post = (body: unknown, adminKey: string | null = ADMIN_KEY) => {
  const req = request(app).post("/v1/admin/accounts");
  if (adminKey !== null) req.set("X-Admin-Key", adminKey);
  return req.send(body as object);
};

const uniqueName = () => `acme-${crypto.randomUUID()}`;

async function accountCountByName(name: string): Promise<number> {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM accounts WHERE name = $1", [name]);
  return rows[0].n;
}

describe("POST /v1/admin/accounts: admin auth", () => {
  it("401 MISSING_ADMIN_KEY without the header", async () => {
    expectProblem(await post({ name: uniqueName() }, null), 401, "MISSING_ADMIN_KEY");
  });

  it("401 INVALID_ADMIN_KEY with a wrong key, and creates nothing", async () => {
    const name = uniqueName();
    expectProblem(await post({ name }, "wrong-key"), 401, "INVALID_ADMIN_KEY");
    expectProblem(await post({ name }, `${ADMIN_KEY}x`), 401, "INVALID_ADMIN_KEY");
    expect(await accountCountByName(name)).toBe(0);
  });

  it("an account API key is not an admin key", async () => {
    const created = await post({ name: uniqueName() });
    expectProblem(await post({ name: uniqueName() }, created.body.apiKey.key), 401, "INVALID_ADMIN_KEY");
  });

  it("an unknown admin route is 404, not 401", async () => {
    const res = await request(app).get("/v1/admin/nope").set("X-Admin-Key", ADMIN_KEY);
    expectProblem(res, 404, "NOT_FOUND");
  });
});

describe("POST /v1/admin/accounts: creation", () => {
  it("201 with the account on Starter by default and an mk_ key shown once", async () => {
    const name = uniqueName();
    const res = await post({ name: `  ${name}  ` });

    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.account).toMatchObject({
      name, // trimmed
      plan: {
        id: PLAN_IDS.starter,
        name: "Starter",
        scope: "account",
        predefined: true,
        rules: { monthlyAllowance: 10_000, maxUnitsPerRequest: 100 },
      },
    });
    expect(res.body.apiKey.key).toMatch(API_KEY_PATTERN);
    expect(res.body.apiKey.prefix).toBe(res.body.apiKey.key.slice(0, 7));
  });

  it("stores only the sha256 hash and prefix, never the plaintext key", async () => {
    const res = await post({ name: uniqueName() });
    const key: string = res.body.apiKey.key;

    const { rows } = await pool.query(
      "SELECT key_hash, key_prefix, row_to_json(k)::text AS whole_row FROM api_keys k WHERE account_id = $1",
      [res.body.account.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].key_hash.equals(hashApiKey(key))).toBe(true);
    expect(rows[0].key_prefix).toBe(key.slice(0, 7));
    expect(rows[0].whole_row).not.toContain(key.slice(3)); // the secret part appears nowhere
  });

  it("accepts a predefined account plan", async () => {
    const res = await post({ name: uniqueName(), planId: PLAN_IDS.pro });
    expect(res.status).toBe(201);
    expect(res.body.account.plan).toMatchObject({ id: PLAN_IDS.pro, name: "Pro" });
  });

  it("400 INVALID_PLAN_SCOPE for a user plan, and creates nothing", async () => {
    const name = uniqueName();
    expectProblem(await post({ name, planId: PLAN_IDS.basic }), 400, "INVALID_PLAN_SCOPE");
    expect(await accountCountByName(name)).toBe(0);
  });

  it("404 PLAN_NOT_FOUND for an unknown plan, and creates nothing", async () => {
    const name = uniqueName();
    expectProblem(await post({ name, planId: crypto.randomUUID() }), 404, "PLAN_NOT_FOUND");
    expect(await accountCountByName(name)).toBe(0);
  });

  it("400 VALIDATION_ERROR listing every bad field", async () => {
    const res = await post({ name: "   ", planId: "not-a-uuid", plan_id: "x" });
    expectProblem(res, 400, "VALIDATION_ERROR");
    const paths = res.body.errors.map((e: { path: string }) => e.path).sort();
    expect(paths).toEqual(["body.name", "body.planId", "body.plan_id"]);
  });

  it("400 VALIDATION_ERROR for a missing body", async () => {
    const res = await request(app).post("/v1/admin/accounts").set("X-Admin-Key", ADMIN_KEY);
    expectProblem(res, 400, "VALIDATION_ERROR");
  });
});
