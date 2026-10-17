import { describe, expect, it } from "vitest";
import { LOCK_NOT_AVAILABLE, pgErrorCode } from "../../src/db/errors.js";
import { lockCounters } from "../../src/repositories/usage.js";
import { consumeAs, createMeteredAccount, setupTestApp } from "../helpers.js";

const { pool, app } = setupTestApp({ poolMax: 5 });

/** Resolves once the backend `pid` is waiting for a lock. */
async function waitUntilBlocked(pid: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [pid]);
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`backend ${pid} never waited for a lock`);
}

describe("lockCounters lock order (real Postgres)", () => {
  // lockCounters locks both counter rows in one statement (data-modifying CTEs). The order
  // inside it is what keeps consumes deadlock-free (§6.3), so prove it: block the user row
  // from outside, and check that the statement waiting for it already holds the account row.
  it("holds the account row while it waits for the user row", async () => {
    const acct = await createMeteredAccount(app, { account: {}, user: {}, users: ["alice"] });
    // Creates this month's counter rows, so there is a user row to block.
    expect((await consumeAs(app, acct.apiKey, { userId: "alice", units: 1 })).body.decision).toBe("accepted");
    const { rows } = await pool.query<{ user_id: string; month: string }>(
      `SELECT c.user_id, to_char(c.month, 'YYYY-MM-DD') AS month
       FROM user_monthly_usage c JOIN users u ON u.id = c.user_id
       WHERE u.account_id = $1 AND u.external_id = 'alice'`,
      [acct.id],
    );
    const { user_id: userId, month } = rows[0]!;

    const blocker = await pool.connect();
    const consumer = await pool.connect();
    const prober = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM user_monthly_usage WHERE user_id = $1 AND month = $2 FOR UPDATE", [
        userId,
        month,
      ]);

      await consumer.query("BEGIN");
      const consumerPid = (await consumer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const locking = lockCounters(acct.id, userId, month, consumer);
      await waitUntilBlocked(consumerPid);

      // The consumer is stuck on the user row. If it locked the account row first, as it
      // must, a NOWAIT lock on the account row fails right away.
      await prober.query("BEGIN");
      const probe = await prober
        .query("SELECT 1 FROM account_monthly_usage WHERE account_id = $1 AND month = $2 FOR UPDATE NOWAIT", [
          acct.id,
          month,
        ])
        .then(
          () => "acquired",
          (err: unknown) => pgErrorCode(err),
        );
      expect(probe, "the account row must be locked before the user row").toBe(LOCK_NOT_AVAILABLE);

      await blocker.query("ROLLBACK");
      await expect(locking).resolves.toEqual({ accountUsed: 1, userUsed: 1 });
    } finally {
      for (const client of [blocker, consumer, prober]) {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    }
  });
});
