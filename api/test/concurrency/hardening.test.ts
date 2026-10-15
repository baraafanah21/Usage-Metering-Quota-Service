import request from "supertest";
import { describe, expect, it } from "vitest";
import { consumeAs, createMeteredAccount, setupTestApp } from "../helpers.js";
import { assertInvariants } from "../invariants.js";

const { pool, app } = setupTestApp({ poolMax: 20 });
// The plan editor gets its own pool, like a second API instance: with a shared pool its
// PATCHes would queue behind the 40 consumes for a connection and rarely interleave.
const { app: adminApp } = setupTestApp({ poolMax: 2 });

describe("plan changes and many tenants under concurrency (real Postgres)", () => {
  it("40 parallel consumes while the user's plan flips maxUnitsPerRequest 10 ↔ 30: every row matches its plan version", async () => {
    const acct = await createMeteredAccount(app, {
      account: {},
      user: { maxUnitsPerRequest: 10 },
      users: ["alice"],
    });
    // The truth about each version, from the PATCH responses (version 1 = as created).
    const limitByVersion = new Map<number, number>([[1, 10]]);

    let consumesDone = false;
    const flipper = (async () => {
      let next = 30;
      let patches = 0;
      while (!consumesDone || patches < 2) {
        const res = await request(adminApp)
          .patch(`/v1/plans/${acct.userPlanId}`)
          .set("X-API-Key", acct.apiKey)
          .send({ rules: { maxUnitsPerRequest: next } });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        limitByVersion.set(res.body.version, res.body.rules.maxUnitsPerRequest);
        next = next === 30 ? 10 : 30;
        patches++;
      }
      return patches;
    })();

    // 5 always fits, 25 fits only under 30, 15 likewise: outcomes depend on the version read.
    const units = [5, 15, 25, 8];
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) => consumeAs(app, acct.apiKey, { userId: "alice", units: units[i % 4]! })),
    );
    consumesDone = true;
    await flipper;

    expect(responses.filter((r) => r.status !== 200).map((r) => [r.status, r.body])).toEqual([]);
    await assertInvariants(pool, acct.id);

    const { rows } = await pool.query<{
      units: string;
      decision: string;
      reject_rule: string | null;
      user_plan_version: number;
      evaluation: { user: { planVersion: number; maxUnitsPerRequest: number } };
    }>(
      `SELECT units, decision, reject_rule, user_plan_version, evaluation
       FROM usage_requests WHERE account_id = $1`,
      [acct.id],
    );
    expect(rows).toHaveLength(40);
    for (const row of rows) {
      const limit = limitByVersion.get(row.user_plan_version);
      const where = `units ${row.units}, v${row.user_plan_version}, ${row.decision}`;
      expect(limit, `${where}: unknown version`).toBeDefined();
      // The snapshot names the same version and that version's real limit.
      expect(row.evaluation.user.planVersion, where).toBe(row.user_plan_version);
      expect(row.evaluation.user.maxUnitsPerRequest, where).toBe(limit);
      if (row.decision === "accepted") {
        expect(Number(row.units), where).toBeLessThanOrEqual(limit!);
      } else {
        expect(row.reject_rule, where).toBe("max_units_per_request");
        expect(Number(row.units), where).toBeGreaterThan(limit!);
      }
    }
    // The flips really interleaved with the consumes.
    expect(new Set(rows.map((r) => r.user_plan_version)).size).toBeGreaterThanOrEqual(2);
  });

  it("5 accounts × 20 parallel consumes, same requestIds everywhere → exact totals, no cross-account rows", async () => {
    // Account k consumes k+1 units per request against an allowance of 10 × (k+1), so exactly
    // 10 of its 20 requests fit, and any foreign row would show up with the wrong units.
    const accounts = await Promise.all(
      Array.from({ length: 5 }, (_, k) =>
        createMeteredAccount(app, {
          account: { monthlyAllowance: 10 * (k + 1) },
          user: {},
          users: ["alice", "bob"],
        }),
      ),
    );

    const responses = await Promise.all(
      accounts.flatMap((acct, k) =>
        Array.from({ length: 20 }, (_, i) =>
          consumeAs(app, acct.apiKey, { userId: i % 2 ? "alice" : "bob", units: k + 1, requestId: `r-${i}` }).then(
            (res) => ({ k, res }),
          ),
        ),
      ),
    );
    expect(responses.filter(({ res }) => res.status !== 200)).toEqual([]);

    for (const [k, acct] of accounts.entries()) {
      const mine = responses.filter((r) => r.k === k).map((r) => r.res.body);
      expect(mine.filter((b) => b.decision === "accepted"), `account ${k}`).toHaveLength(10);
      expect(mine.every((b) => b.replayed === false && b.units === k + 1)).toBe(true);

      const totals = await assertInvariants(pool, acct.id);
      expect(totals.account, `account ${k}`).toBe(10 * (k + 1));

      const history = await request(app).get("/v1/requests").query({ limit: 100 }).set("X-API-Key", acct.apiKey);
      expect(history.body.requests).toHaveLength(20);
      expect(history.body.requests.every((r: { units: number }) => r.units === k + 1)).toBe(true);
      expect(new Set(history.body.requests.map((r: { requestId: string }) => r.requestId)).size).toBe(20);

      const usage = await request(app).get("/v1/usage").set("X-API-Key", acct.apiKey);
      expect(usage.body.account).toMatchObject({ used: 10 * (k + 1), remaining: 0 });
      const sumOfUsers = usage.body.users.reduce((s: number, u: { used: number }) => s + u.used, 0);
      expect(sumOfUsers).toBe(10 * (k + 1));
    }
  });
});
