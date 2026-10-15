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
 * Appends one decision. Raises unique_violation on LEDGER_REQUEST_UNIQUE when the same
 * requestId was recorded first by a concurrent request; the caller's transaction then
 * rolls back, taking any counter increment with it.
 */
export async function insertRequest(accountId: string, row: NewLedgerRow, db: Queryable): Promise<void> {
  await db.query(
    `INSERT INTO usage_requests
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
