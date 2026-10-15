import { describe, expect, it } from "vitest";
import { consumeAs, createMeteredAccount, setupTestApp } from "../helpers.js";
import { assertInvariants } from "../invariants.js";

// More connections than the default so requests really overlap inside Postgres.
const { pool, app } = setupTestApp({ poolMax: 20 });

describe("consume under concurrency (real Postgres)", () => {
  it("allowance 100, 10 users, 50 parallel requests of 5 → exactly 20 accepted, used == 100", async () => {
    const users = Array.from({ length: 10 }, (_, i) => `u${i}`);
    const acct = await createMeteredAccount(app, { account: { monthlyAllowance: 100 }, user: {}, users });

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) => consumeAs(app, acct.apiKey, { userId: users[i % 10]!, units: 5 })),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    const accepted = responses.filter((r) => r.body.decision === "accepted");
    expect(accepted).toHaveLength(20);
    for (const r of responses.filter((r) => r.body.decision === "rejected")) {
      expect(r.body.reason).toMatchObject({ scope: "account", rule: "monthly_allowance" });
    }
    // Every accepted response saw a distinct, consistent counter value: 5, 10, ..., 100.
    expect(accepted.map((r) => r.body.account.used).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => (i + 1) * 5),
    );

    const totals = await assertInvariants(pool, acct.id);
    expect(totals.account).toBe(100);
  });

  it("30 parallel requests with the same requestId → 1 ledger row, 1 increment, one decision", async () => {
    const acct = await createMeteredAccount(app, { account: { monthlyAllowance: 1_000 }, user: {}, users: ["alice"] });

    const responses = await Promise.all(
      Array.from({ length: 30 }, () => consumeAs(app, acct.apiKey, { userId: "alice", units: 7, requestId: "same" })),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(new Set(responses.map((r) => r.body.decision))).toEqual(new Set(["accepted"]));
    expect(responses.filter((r) => !r.body.replayed)).toHaveLength(1);
    // Every replay is the winner's stored response.
    const winner = responses.find((r) => !r.body.replayed)!.body;
    for (const r of responses.filter((r) => r.body.replayed)) {
      expect(r.body).toEqual({ ...winner, replayed: true });
      expect(r.headers["idempotent-replayed"]).toBe("true");
    }

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM usage_requests WHERE account_id = $1", [acct.id]);
    expect(rows[0].n).toBe(1);
    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 7, users: { alice: 7 } });
  });

  it("30 parallel identical oversized requests (no locks taken) → still exactly 1 ledger row", async () => {
    const acct = await createMeteredAccount(app, { account: {}, user: { maxUnitsPerRequest: 5 }, users: ["alice"] });

    const responses = await Promise.all(
      Array.from({ length: 30 }, () => consumeAs(app, acct.apiKey, { userId: "alice", units: 9, requestId: "big" })),
    );

    expect(new Set(responses.map((r) => r.body.decision))).toEqual(new Set(["rejected"]));
    expect(responses.filter((r) => !r.body.replayed)).toHaveLength(1);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM usage_requests WHERE account_id = $1", [acct.id]);
    expect(rows[0].n).toBe(1);
    expect(await assertInvariants(pool, acct.id)).toEqual({ account: 0, users: { alice: 0 } });
  });

  it("parallel consumes for one user against both limits never over-grant either level", async () => {
    const acct = await createMeteredAccount(app, {
      account: { monthlyAllowance: 60 },
      user: { monthlyAllowance: 40 },
      users: ["alice", "bob"],
    });
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => consumeAs(app, acct.apiKey, { userId: i % 2 ? "alice" : "bob", units: 3 })),
    );

    const totals = await assertInvariants(pool, acct.id);
    expect(totals.account).toBeLessThanOrEqual(60);
    expect(totals.users.alice).toBeLessThanOrEqual(40);
    expect(totals.users.bob).toBeLessThanOrEqual(40);
    // 60 / 3 = 20 requests fit the account; each user alone could take 13 (39 units).
    expect(totals.account).toBe(60);
  });
});
