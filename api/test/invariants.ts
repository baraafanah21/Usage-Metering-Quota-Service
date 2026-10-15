import type { Pool } from "pg";
import { expect } from "vitest";

const CURRENT_MONTH = "date_trunc('month', now() AT TIME ZONE 'UTC')::date";

export interface Totals {
  account: number;
  users: Record<string, number>;
}

/**
 * The correctness invariants of DESIGN.md §4.2 for one account, current month:
 *  I5: every counter == SUM(units) of its accepted ledger rows (account and each user)
 *  I6: the account counter == SUM of its users' counters
 * Returns the counters (by externalId) so tests can assert on them too.
 */
export async function assertInvariants(pool: Pool, accountId: string): Promise<Totals> {
  const account = await pool.query<{ counter: string; ledger: string }>(
    `SELECT COALESCE((SELECT used FROM account_monthly_usage
                      WHERE account_id = $1 AND month = ${CURRENT_MONTH}), 0) AS counter,
            COALESCE((SELECT sum(units) FROM usage_requests
                      WHERE account_id = $1 AND month = ${CURRENT_MONTH}
                        AND decision = 'accepted'), 0) AS ledger`,
    [accountId],
  );
  const users = await pool.query<{ external_id: string; counter: string; ledger: string }>(
    `SELECT u.external_id,
            COALESCE(c.used, 0)  AS counter,
            COALESCE(l.total, 0) AS ledger
     FROM users u
     LEFT JOIN user_monthly_usage c ON c.user_id = u.id AND c.month = ${CURRENT_MONTH}
     LEFT JOIN (SELECT user_id, sum(units) AS total FROM usage_requests
                WHERE account_id = $1 AND month = ${CURRENT_MONTH} AND decision = 'accepted'
                GROUP BY user_id) l ON l.user_id = u.id
     WHERE u.account_id = $1
     ORDER BY u.external_id`,
    [accountId],
  );

  const accountCounter = Number(account.rows[0]!.counter);
  expect(accountCounter, "I5: account counter == Σ accepted ledger units").toBe(Number(account.rows[0]!.ledger));

  const totals: Totals = { account: accountCounter, users: {} };
  let sumOfUsers = 0;
  for (const row of users.rows) {
    expect(Number(row.counter), `I5: user '${row.external_id}' counter == Σ its accepted units`).toBe(
      Number(row.ledger),
    );
    totals.users[row.external_id] = Number(row.counter);
    sumOfUsers += Number(row.counter);
  }
  expect(accountCounter, "I6: account counter == Σ user counters").toBe(sumOfUsers);
  return totals;
}
