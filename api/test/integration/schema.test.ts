import { beforeAll, describe, expect, it } from "vitest";
import { PLAN_IDS } from "../../src/db/seed.js";
import { createTestAccount, setupTestApp, type TestAccount } from "../helpers.js";

const { pool, app } = setupTestApp();
let account: TestAccount;
let userId: string;

beforeAll(async () => {
  account = await createTestAccount(app);
  // Users have no API yet (Phase 3); insert directly to exercise the ledger constraints.
  const { rows } = await pool.query(
    "INSERT INTO users (account_id, external_id, plan_id) VALUES ($1, 'alice', $2) RETURNING id",
    [account.id, PLAN_IDS.basic],
  );
  userId = rows[0].id;
});

function insertLedgerRow(accountId: string, requestId: string) {
  return pool.query(
    `INSERT INTO usage_requests
       (account_id, user_id, request_id, units, decision, month,
        account_plan_id, account_plan_version, user_plan_id, user_plan_version, evaluation)
     VALUES ($1, $2, $3, 1, 'accepted', '2026-10-01', $4, 1, $5, 1, '{}')`,
    [accountId, userId, requestId, PLAN_IDS.starter, PLAN_IDS.basic],
  );
}

describe("schema constraints", () => {
  it("rejects a negative usage counter (CHECK used >= 0)", async () => {
    await expect(
      pool.query(
        "INSERT INTO account_monthly_usage (account_id, month, used) VALUES ($1, '2026-10-01', -1)",
        [account.id],
      ),
    ).rejects.toMatchObject({ code: "23514" }); // check_violation
  });

  it("rejects a duplicate (account_id, request_id) in the ledger", async () => {
    await insertLedgerRow(account.id, "req-1");
    await expect(insertLedgerRow(account.id, "req-1")).rejects.toMatchObject({
      code: "23505", // unique_violation
    });
  });

  it("rejects a ledger row attributing a user to another account (composite FK)", async () => {
    const other = await createTestAccount(app);
    await expect(insertLedgerRow(other.id, "req-x")).rejects.toMatchObject({
      code: "23503", // foreign_key_violation
    });
  });
});
