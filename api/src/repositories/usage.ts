import type { Queryable } from "../db/tx.js";
import type { UserCursor } from "./users.js";

/** One level's usage for a month, against the plan assigned NOW (§16.15). */
export interface LevelUsage {
  planId: string;
  planName: string;
  /** null = no monthly rule (unlimited). */
  monthlyAllowance: number | null;
  used: number;
}

export interface AccountMonthUsage extends LevelUsage {
  /** "YYYY-MM" */
  month: string;
  /** The same month as 'YYYY-MM-DD', for follow-up queries in this request. */
  monthStart: string;
}

export interface UserMonthUsage extends LevelUsage {
  externalId: string;
}

// The requested month ($2, 'YYYY-MM-DD' or NULL), or the current UTC month by the database clock.
const MONTH_CTE = `m AS (SELECT COALESCE($2::date, date_trunc('month', now() AT TIME ZONE 'UTC')::date) AS month)`;

interface LevelUsageRow {
  plan_id: string;
  plan_name: string;
  monthly: string | null;
  used: string;
}

const toLevelUsage = (r: LevelUsageRow): LevelUsage => ({
  planId: r.plan_id,
  planName: r.plan_name,
  monthlyAllowance: r.monthly === null ? null : Number(r.monthly),
  used: Number(r.used),
});

/**
 * The account's plan and counter for a month (default: current). A missing counter row means
 * nothing was accepted that month: used 0. Undefined only if the account does not exist.
 */
export async function accountMonthUsage(
  accountId: string,
  month: string | null,
  db: Queryable,
): Promise<AccountMonthUsage | undefined> {
  const { rows } = await db.query<LevelUsageRow & { month: string; month_start: string }>(
    `WITH ${MONTH_CTE}
     SELECT to_char(m.month, 'YYYY-MM') AS month, to_char(m.month, 'YYYY-MM-DD') AS month_start,
            p.id AS plan_id, p.name AS plan_name, r."limit" AS monthly, COALESCE(c.used, 0) AS used
     FROM m
     JOIN accounts a ON a.id = $1
     JOIN plans p ON p.id = a.plan_id
     LEFT JOIN plan_rules r ON r.plan_id = p.id AND r.type = 'monthly_allowance'
     LEFT JOIN account_monthly_usage c ON c.account_id = a.id AND c.month = m.month`,
    [accountId, month],
  );
  const r = rows[0];
  return r && { month: r.month, monthStart: r.month_start, ...toLevelUsage(r) };
}

/** One user's plan and counter for a month (default: current). Undefined if no such user here. */
export async function userMonthUsage(
  accountId: string,
  externalId: string,
  month: string | null,
  db: Queryable,
): Promise<(UserMonthUsage & { month: string }) | undefined> {
  const { rows } = await db.query<LevelUsageRow & { month: string; external_id: string }>(
    `WITH ${MONTH_CTE}
     SELECT to_char(m.month, 'YYYY-MM') AS month, u.external_id,
            p.id AS plan_id, p.name AS plan_name, r."limit" AS monthly, COALESCE(c.used, 0) AS used
     FROM m
     JOIN users u ON u.account_id = $1 AND u.external_id = $3
     JOIN plans p ON p.id = u.plan_id
     LEFT JOIN plan_rules r ON r.plan_id = p.id AND r.type = 'monthly_allowance'
     LEFT JOIN user_monthly_usage c ON c.user_id = u.id AND c.month = m.month`,
    [accountId, month, externalId],
  );
  const r = rows[0];
  return r && { month: r.month, externalId: r.external_id, ...toLevelUsage(r) };
}

/**
 * One page of users with their usage for the month, in the same (created_at, id) keyset
 * order as GET /v1/users (index users_account_created). One query for the whole page: the
 * plan, its monthly rule and the counter are joined, not fetched per user.
 */
export async function userUsagePage(
  accountId: string,
  monthStart: string,
  page: { limit: number; after: UserCursor | undefined },
  db: Queryable,
): Promise<{ users: UserMonthUsage[]; next: UserCursor | null }> {
  const { rows } = await db.query<LevelUsageRow & { id: string; external_id: string; created_at_text: string }>(
    `SELECT u.id, u.external_id,
            to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text,
            p.id AS plan_id, p.name AS plan_name, r."limit" AS monthly, COALESCE(c.used, 0) AS used
     FROM users u
     JOIN plans p ON p.id = u.plan_id
     LEFT JOIN plan_rules r ON r.plan_id = p.id AND r.type = 'monthly_allowance'
     LEFT JOIN user_monthly_usage c ON c.user_id = u.id AND c.month = $2::date
     WHERE u.account_id = $1
       AND ($3::timestamptz IS NULL OR (u.created_at, u.id) > ($3::timestamptz, $4::uuid))
     ORDER BY u.created_at, u.id
     LIMIT $5`,
    [accountId, monthStart, page.after?.createdAt ?? null, page.after?.id ?? null, page.limit + 1],
  );

  const hasMore = rows.length > page.limit;
  const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
  const last = pageRows.at(-1);
  return {
    users: pageRows.map((r) => ({ externalId: r.external_id, ...toLevelUsage(r) })),
    next: hasMore && last ? { createdAt: last.created_at_text, id: last.id } : null,
  };
}

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
 * Locks the account's counter row for the month, then the user's, until the transaction ends,
 * creating either on first use, in one statement. ON CONFLICT DO UPDATE (a no-op update) is
 * what takes the lock on an existing row, so concurrent consumes for one account queue here
 * and each sees the previous one's committed increment.
 *
 * Lock order (§6.3) inside the statement: the sub-statements of a WITH run in no guaranteed
 * order, so the order is forced by data. The user INSERT takes its row FROM account_row, and
 * account_row yields its row only after the account INSERT has locked it. So the user row is
 * never locked first, every consume still locks account then user, and no two consumes can
 * wait on each other in a cycle. test/concurrency/lockOrder.test.ts checks this.
 */
export async function lockCounters(
  accountId: string,
  userId: string,
  month: string,
  db: Queryable,
): Promise<{ accountUsed: number; userUsed: number }> {
  const { rows } = await db.query<{ account_used: string; user_used: string }>(
    `WITH account_row AS (
       INSERT INTO account_monthly_usage (account_id, month, used) VALUES ($1, $3::date, 0)
       ON CONFLICT (account_id, month) DO UPDATE SET used = account_monthly_usage.used
       RETURNING used
     ), user_row AS (
       INSERT INTO user_monthly_usage (user_id, account_id, month, used)
       SELECT $2::uuid, $1::uuid, $3::date, 0 FROM account_row
       ON CONFLICT (user_id, month) DO UPDATE SET used = user_monthly_usage.used
       RETURNING used
     )
     SELECT account_row.used AS account_used, user_row.used AS user_used FROM account_row, user_row`,
    [accountId, userId, month],
  );
  const r = rows[0]!;
  return { accountUsed: Number(r.account_used), userUsed: Number(r.user_used) };
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
