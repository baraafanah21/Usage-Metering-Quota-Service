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
