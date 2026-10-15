import type { Queryable } from "../db/tx.js";

export interface MonthUsage {
  /** "YYYY-MM", the current UTC month by the database clock (§4.1). */
  month: string;
  accountUsed: number;
  /** 0 when no userId was given. */
  userUsed: number;
}

/**
 * Both counters for the current month in one query. A missing counter row means nothing
 * was accepted yet this month, so it reads as 0. The month comes from Postgres, never the
 * app clock, so every instance agrees on it.
 */
export async function currentMonthUsage(
  accountId: string,
  userId: string | null,
  db: Queryable,
): Promise<MonthUsage> {
  const { rows } = await db.query<{ month: string; account_used: string; user_used: string }>(
    `WITH m AS (SELECT date_trunc('month', now() AT TIME ZONE 'UTC')::date AS month)
     SELECT to_char(m.month, 'YYYY-MM') AS month,
            COALESCE((SELECT used FROM account_monthly_usage
                      WHERE account_id = $1 AND month = m.month), 0) AS account_used,
            COALESCE((SELECT used FROM user_monthly_usage
                      WHERE account_id = $1 AND user_id = $2 AND month = m.month), 0) AS user_used
     FROM m`,
    [accountId, userId],
  );
  const r = rows[0]!;
  return { month: r.month, accountUsed: Number(r.account_used), userUsed: Number(r.user_used) };
}

// The functions below take the month explicitly ('YYYY-MM-DD', first of the month) so that
// every statement in one consume transaction uses the same month the user query returned.

/**
 * Locks the account's counter row for the month until the transaction ends, creating it on
 * first use. ON CONFLICT DO UPDATE (a no-op update) takes the row lock, so concurrent
 * consumes for one account queue here and each sees the previous one's committed increment.
 */
export async function lockAccountCounter(
  accountId: string,
  month: string,
  db: Queryable,
): Promise<number> {
  const { rows } = await db.query<{ used: string }>(
    `INSERT INTO account_monthly_usage (account_id, month, used) VALUES ($1, $2::date, 0)
     ON CONFLICT (account_id, month) DO UPDATE SET used = account_monthly_usage.used
     RETURNING used`,
    [accountId, month],
  );
  return Number(rows[0]!.used);
}

/** Same as lockAccountCounter for the user's row. Always called after it (fixed lock order). */
export async function lockUserCounter(
  accountId: string,
  userId: string,
  month: string,
  db: Queryable,
): Promise<number> {
  const { rows } = await db.query<{ used: string }>(
    `INSERT INTO user_monthly_usage (user_id, account_id, month, used) VALUES ($2, $1, $3::date, 0)
     ON CONFLICT (user_id, month) DO UPDATE SET used = user_monthly_usage.used
     RETURNING used`,
    [accountId, userId, month],
  );
  return Number(rows[0]!.used);
}

/** Both counters without any lock. For display only: no decision may depend on these. */
export async function readCounters(
  accountId: string,
  userId: string,
  month: string,
  db: Queryable,
): Promise<{ accountUsed: number; userUsed: number }> {
  const { rows } = await db.query<{ account_used: string; user_used: string }>(
    `SELECT COALESCE((SELECT used FROM account_monthly_usage
                      WHERE account_id = $1 AND month = $3::date), 0) AS account_used,
            COALESCE((SELECT used FROM user_monthly_usage
                      WHERE account_id = $1 AND user_id = $2 AND month = $3::date), 0) AS user_used`,
    [accountId, userId, month],
  );
  const r = rows[0]!;
  return { accountUsed: Number(r.account_used), userUsed: Number(r.user_used) };
}

/** Adds units to both rows. Callers must hold both row locks (lockAccountCounter/lockUserCounter). */
export async function incrementCounters(
  accountId: string,
  userId: string,
  month: string,
  units: number,
  db: Queryable,
): Promise<void> {
  await db.query(
    "UPDATE account_monthly_usage SET used = used + $3 WHERE account_id = $1 AND month = $2::date",
    [accountId, month, units],
  );
  await db.query(
    `UPDATE user_monthly_usage SET used = used + $4
     WHERE account_id = $1 AND user_id = $2 AND month = $3::date`,
    [accountId, userId, month, units],
  );
}
