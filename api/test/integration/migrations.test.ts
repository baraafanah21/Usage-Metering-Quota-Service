import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { listMigrations, migrate } from "../../src/db/migrate.js";
import { createPool } from "../../src/db/pool.js";
import { PLAN_IDS, seed } from "../../src/db/seed.js";
import { ADMIN_KEY, config, logger } from "../helpers.js";

// The shared test database is already migrated by globalSetup, so these tests use their
// own empty database to observe a real first run.
const dbName = `metering_migrate_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
let pool: pg.Pool;

beforeAll(async () => {
  await adminPool.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(config.DATABASE_URL);
  url.pathname = `/${dbName}`;
  pool = createPool({ connectionString: url.toString(), max: 4 }, logger);
});

afterAll(async () => {
  await pool.end();
  await adminPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await adminPool.end();
});

describe("migrations and seed", () => {
  it("readiness is 503 before migrating", async () => {
    const res = await request(createApp({ pool, logger, adminApiKey: ADMIN_KEY })).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "SERVICE_UNAVAILABLE", title: "Database not migrated" });
  });

  it("two concurrent runs both succeed and apply each migration once", async () => {
    await Promise.all([migrate(pool, logger), migrate(pool, logger)]);

    const { rows } = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    expect(rows.map((r) => r.version)).toEqual(listMigrations().map((m) => m.version));
  });

  it("running again is a no-op", async () => {
    const before = await pool.query("SELECT version, applied_at FROM schema_migrations ORDER BY version");
    await migrate(pool, logger);
    const after = await pool.query("SELECT version, applied_at FROM schema_migrations ORDER BY version");
    expect(after.rows).toEqual(before.rows);
  });

  it("seeding twice leaves exactly the 4 predefined plans with their rules", async () => {
    await seed(pool, logger);
    await seed(pool, logger);

    const { rows } = await pool.query(`
      SELECT p.id, p.scope, p.name,
             max(r."limit") FILTER (WHERE r.type = 'monthly_allowance')::int     AS monthly,
             max(r."limit") FILTER (WHERE r.type = 'max_units_per_request')::int AS per_request
      FROM plans p JOIN plan_rules r ON r.plan_id = p.id
      WHERE p.owner_account_id IS NULL
      GROUP BY p.id ORDER BY p.id`);
    expect(rows).toEqual([
      { id: PLAN_IDS.starter, scope: "account", name: "Starter", monthly: 10_000, per_request: 100 },
      { id: PLAN_IDS.pro, scope: "account", name: "Pro", monthly: 100_000, per_request: 500 },
      { id: PLAN_IDS.basic, scope: "user", name: "Basic", monthly: 1_000, per_request: 20 },
      { id: PLAN_IDS.premium, scope: "user", name: "Premium", monthly: 5_000, per_request: 100 },
    ]);
    const rules = await pool.query("SELECT count(*)::int AS n FROM plan_rules");
    expect(rules.rows[0].n).toBe(8);
  });

  it("readiness is 200 once migrated", async () => {
    const res = await request(createApp({ pool, logger, adminApiKey: ADMIN_KEY })).get("/health/ready");
    expect(res.status).toBe(200);
  });
});
