import type { Queryable } from "../db/tx.js";
import type { Decision, RuleType, Scope } from "../domain/rules.js";

/** The UNIQUE (account_id, request_id) constraint from 001_init.sql: the idempotency key. */
export const LEDGER_REQUEST_UNIQUE = "usage_requests_account_id_request_id_key";

export interface StoredRequest {
  /** The user's externalId, for comparing a retry's payload with the original. */
  externalId: string;
  units: number;
  /** The exact response body returned when the decision was made. */
  response: unknown;
}

export interface NewLedgerRow {
  userId: string;
  requestId: string;
  units: number;
  decision: Decision;
  rejectScope: Scope | null;
  rejectRule: RuleType | null;
  month: string;
  accountPlanId: string;
  accountPlanVersion: number;
  userPlanId: string;
  userPlanVersion: number;
  /** Stored as jsonb in `evaluation`; replays return it verbatim. */
  response: unknown;
}

export interface LedgerEntry {
  /** The ledger's identity column, as text (bigint). Pagination position, never shown. */
  id: string;
  requestId: string;
  externalId: string;
  units: number;
  decision: Decision;
  rejectScope: Scope | null;
  rejectRule: RuleType | null;
  /** "YYYY-MM" */
  month: string;
  createdAt: Date;
  accountPlanId: string;
  accountPlanVersion: number;
  userPlanId: string;
  userPlanVersion: number;
  /** The stored response snapshot; only loaded when asked for. */
  evaluation?: unknown;
}

export interface HistoryFilters {
  /** Internal user id (already resolved from the externalId and scoped to the account). */
  userId?: string | undefined;
  /** 'YYYY-MM-DD', first of the month. */
  month?: string | undefined;
  decision?: Decision | undefined;
}

/**
 * One page of the account's ledger, newest first: WHERE id < $cursor ORDER BY id DESC
 * LIMIT limit + 1. Only the filters given become predicates, and each combination is read in
 * order from one §4 index: usage_requests_user_hist (userId, with or without other filters),
 * usage_requests_account_month (month), usage_requests_account_hist (none, or decision).
 *
 * That index's columns before id are matched as one-value ranges and kept in the sort key,
 * e.g. ORDER BY account_id, month, id DESC. With a plain `= $1`, Postgres treats a column as
 * a constant, so other orderings also yield "id DESC" (a backward scan of the primary key, or
 * of account_hist when a month is given), and it may pick one that filters its way through
 * every newer row of everyone else (30,000 rows read for one page in the PR's EXPLAIN). With
 * the ranges, only the intended index can produce the order. Same rows, same order.
 */
export async function listRequests(
  accountId: string,
  page: { filters: HistoryFilters; limit: number; before: string | undefined; withEvaluation: boolean },
  db: Queryable,
): Promise<{ requests: LedgerEntry[]; next: string | null }> {
  const { userId, month, decision } = page.filters;
  const values: unknown[] = [accountId];
  const where: string[] = [];
  const add = (predicate: (param: string) => string, value: unknown) => {
    values.push(value);
    where.push(predicate(`$${values.length}`));
  };
  const onlyValue = (column: string, type: string) => (p: string) =>
    `${column} >= ${p}::${type} AND ${column} <= ${p}::${type}`;
  const sortKey: string[] = [];
  if (userId !== undefined) {
    // usage_requests_user_hist (user_id, id DESC); the account check stays as a plain filter.
    where.push("r.account_id = $1");
    add(onlyValue("r.user_id", "uuid"), userId);
    sortKey.push("r.user_id");
    if (month !== undefined) add((p) => `r.month = ${p}::date`, month);
  } else {
    // usage_requests_account_month (account_id, month, id DESC) or account_hist (account_id, id DESC).
    where.push(onlyValue("r.account_id", "uuid")("$1"));
    sortKey.push("r.account_id");
    if (month !== undefined) {
      add(onlyValue("r.month", "date"), month);
      sortKey.push("r.month");
    }
  }
  if (decision !== undefined) add((p) => `r.decision = ${p}::decision`, decision);
  if (page.before !== undefined) add((p) => `r.id < ${p}::bigint`, page.before);
  values.push(page.limit + 1);

  const { rows } = await db.query<{
    id: string;
    request_id: string;
    external_id: string;
    units: string;
    decision: Decision;
    reject_scope: Scope | null;
    reject_rule: RuleType | null;
    month: string;
    created_at: Date;
    account_plan_id: string;
    account_plan_version: number;
    user_plan_id: string;
    user_plan_version: number;
    evaluation: unknown;
  }>(
    // externalId is looked up for the returned rows only (users_pkey), not joined: a join lets
    // the planner start from users and probe the ledger once per user of the whole table. The
    // composite FK (user_id, account_id) already guarantees the user is this account's.
    `SELECT r.id::text AS id, r.request_id,
            (SELECT u.external_id FROM users u WHERE u.id = r.user_id) AS external_id,
            r.units, r.decision, r.reject_scope, r.reject_rule, to_char(r.month, 'YYYY-MM') AS month,
            r.created_at, r.account_plan_id, r.account_plan_version, r.user_plan_id, r.user_plan_version,
            ${page.withEvaluation ? "r.evaluation" : "NULL::jsonb AS evaluation"}
     FROM usage_requests r
     WHERE ${where.join(" AND ")}
     ORDER BY ${sortKey.join(", ")}, r.id DESC
     LIMIT $${values.length}`,
    values,
  );

  const hasMore = rows.length > page.limit;
  const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
  return {
    requests: pageRows.map((r) => ({
      id: r.id,
      requestId: r.request_id,
      externalId: r.external_id,
      units: Number(r.units),
      decision: r.decision,
      rejectScope: r.reject_scope,
      rejectRule: r.reject_rule,
      month: r.month,
      createdAt: r.created_at,
      accountPlanId: r.account_plan_id,
      accountPlanVersion: r.account_plan_version,
      userPlanId: r.user_plan_id,
      userPlanVersion: r.user_plan_version,
      ...(page.withEvaluation && { evaluation: r.evaluation }),
    })),
    next: hasMore ? pageRows.at(-1)!.id : null,
  };
}

/** The decision already recorded for this requestId in this account, if any. */
export async function findRequest(
  accountId: string,
  requestId: string,
  db: Queryable,
): Promise<StoredRequest | undefined> {
  const { rows } = await db.query<{ external_id: string; units: string; evaluation: unknown }>(
    `SELECT u.external_id, r.units, r.evaluation
     FROM usage_requests r
     JOIN users u ON u.id = r.user_id AND u.account_id = r.account_id
     WHERE r.account_id = $1 AND r.request_id = $2`,
    [accountId, requestId],
  );
  const r = rows[0];
  return r && { externalId: r.external_id, units: Number(r.units), response: r.evaluation };
}

/**
 * Appends one decision to the ledger and, if it was accepted, adds its units to the account's
 * and the user's counters: one statement, so both counters and the ledger change together or
 * not at all. An accepted decision was evaluated against counter rows locked by lockCounters,
 * which this transaction still holds. Raises unique_violation on LEDGER_REQUEST_UNIQUE when the
 * same requestId was recorded first by a concurrent request; the statement and the caller's
 * transaction then roll back, increments included.
 */
export async function recordDecision(accountId: string, row: NewLedgerRow, db: Queryable): Promise<void> {
  await db.query(
    `WITH account_increment AS (
       UPDATE account_monthly_usage SET used = used + $4
       WHERE account_id = $1 AND month = $8::date AND $5::decision = 'accepted'
     ), user_increment AS (
       UPDATE user_monthly_usage SET used = used + $4
       WHERE account_id = $1 AND user_id = $2 AND month = $8::date AND $5::decision = 'accepted'
     )
     INSERT INTO usage_requests
       (account_id, user_id, request_id, units, decision, reject_scope, reject_rule, month,
        account_plan_id, account_plan_version, user_plan_id, user_plan_version, evaluation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11, $12, $13)`,
    [
      accountId,
      row.userId,
      row.requestId,
      row.units,
      row.decision,
      row.rejectScope,
      row.rejectRule,
      row.month,
      row.accountPlanId,
      row.accountPlanVersion,
      row.userPlanId,
      row.userPlanVersion,
      JSON.stringify(row.response),
    ],
  );
}
