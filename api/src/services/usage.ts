import type { Pool } from "pg";
import { AppError } from "../domain/errors.js";
import { monthStart } from "../domain/month.js";
import { type Decision, remaining } from "../domain/rules.js";
import { type LedgerEntry, listRequests } from "../repositories/requests.js";
import { accountMonthUsage, type LevelUsage, userMonthUsage, userUsagePage } from "../repositories/usage.js";
import { findUser, type UserCursor } from "../repositories/users.js";
import { userNotFound } from "./users.js";

/**
 * Used and remaining at one level. remaining is computed against the plan assigned NOW, also
 * for past months (§16.15); the limits actually applied are in each ledger row's snapshot.
 */
export interface LevelUsageView {
  planId: string;
  planName: string;
  monthlyAllowance: number | null;
  used: number;
  /** null = unlimited; never negative. */
  remaining: number | null;
}

export interface AccountUsage {
  month: string;
  account: LevelUsageView;
  users: (LevelUsageView & { userId: string })[];
  next: UserCursor | null;
}

const withRemaining = (level: LevelUsage): LevelUsageView => ({
  planId: level.planId,
  planName: level.planName,
  monthlyAllowance: level.monthlyAllowance,
  used: level.used,
  remaining: remaining(level.monthlyAllowance ?? undefined, level.used),
});

/** "2026-10" → '2026-10-01'; undefined → null, which the SQL reads as "current month". */
const toMonthStart = (month: string | undefined) => (month === undefined ? null : monthStart(month));

/**
 * GET /v1/usage: the account's level plus one page of its users for a month. Two queries
 * whatever the page size: the account row, then the users page with plans and counters joined.
 */
export async function getAccountUsage(
  pool: Pool,
  accountId: string,
  query: { month: string | undefined; limit: number; after: UserCursor | undefined },
): Promise<AccountUsage> {
  const account = await accountMonthUsage(accountId, toMonthStart(query.month), pool);
  // A valid API key implies the account exists (FK), so this is a should-not-happen.
  if (!account) throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found");
  // The month the first query resolved, so both queries agree even across midnight UTC.
  const page = await userUsagePage(accountId, account.monthStart, query, pool);
  return {
    month: account.month,
    account: withRemaining(account),
    users: page.users.map((u) => ({ userId: u.externalId, ...withRemaining(u) })),
    next: page.next,
  };
}

/** GET /v1/users/:externalId/usage: one user's used/remaining for a month. One query. */
export async function getUserUsage(
  pool: Pool,
  accountId: string,
  externalId: string,
  month: string | undefined,
): Promise<{ month: string; userId: string } & LevelUsageView> {
  const usage = await userMonthUsage(accountId, externalId, toMonthStart(month), pool);
  if (!usage) throw userNotFound(externalId);
  return { month: usage.month, userId: usage.externalId, ...withRemaining(usage) };
}

/**
 * GET /v1/requests: this account's ledger, newest first. A userId filter is resolved first
 * (scoped to the account), so an unknown or foreign user is 404 rather than an empty page.
 */
export async function listHistory(
  pool: Pool,
  accountId: string,
  query: {
    userId: string | undefined;
    month: string | undefined;
    decision: Decision | undefined;
    limit: number;
    before: string | undefined;
    withEvaluation: boolean;
  },
): Promise<{ requests: LedgerEntry[]; next: string | null }> {
  let userId: string | undefined;
  if (query.userId !== undefined) {
    const user = await findUser(accountId, query.userId, pool);
    if (!user) throw userNotFound(query.userId);
    userId = user.id;
  }
  return listRequests(
    accountId,
    {
      filters: { userId, month: query.month && monthStart(query.month), decision: query.decision },
      limit: query.limit,
      before: query.before,
      withEvaluation: query.withEvaluation,
    },
    pool,
  );
}
