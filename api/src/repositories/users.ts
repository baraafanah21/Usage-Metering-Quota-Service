import type { Queryable } from "../db/tx.js";
import type { PlanRules } from "./plans.js";

export interface User {
  id: string;
  externalId: string;
  planId: string;
  createdAt: Date;
}

export interface UserListItem {
  externalId: string;
  plan: { id: string; name: string };
  createdAt: Date;
}

/** Position in the (created_at, id) order. createdAt is Postgres text at full microsecond
 *  precision: a JS Date keeps only milliseconds and would skip or repeat rows. */
export interface UserCursor {
  createdAt: string;
  id: string;
}

/** Just what evaluation needs from a plan. */
export interface PlanRef {
  id: string;
  name: string;
  version: number;
  rules: PlanRules;
}

export interface UserWithPlans {
  user: User;
  userPlan: PlanRef;
  accountPlan: PlanRef;
  /** First day of the current UTC month by the database clock, as 'YYYY-MM-DD' (§4.1).
   *  now() is fixed per transaction, so inside one it never changes. */
  month: string;
}

interface UserRow {
  id: string;
  external_id: string;
  plan_id: string;
  created_at: Date;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  externalId: row.external_id,
  planId: row.plan_id,
  createdAt: row.created_at,
});

const toLimit = (value: string | null) => (value === null ? null : Number(value));

/** Raises unique_violation on users_account_id_external_id_key if the id is taken. */
export async function insertUser(
  accountId: string,
  input: { externalId: string; planId: string },
  db: Queryable,
): Promise<User> {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (account_id, external_id, plan_id) VALUES ($1, $2, $3)
     RETURNING id, external_id, plan_id, created_at`,
    [accountId, input.externalId, input.planId],
  );
  return toUser(rows[0]!);
}

export async function findUser(
  accountId: string,
  externalId: string,
  db: Queryable,
): Promise<User | undefined> {
  const { rows } = await db.query<UserRow>(
    `SELECT id, external_id, plan_id, created_at FROM users
     WHERE account_id = $1 AND external_id = $2`,
    [accountId, externalId],
  );
  return rows[0] && toUser(rows[0]);
}

/** Changes only the assignment; usage counters are untouched (§6.5). False if no such user. */
export async function setUserPlan(
  accountId: string,
  externalId: string,
  planId: string,
  db: Queryable,
): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE users SET plan_id = $3 WHERE account_id = $1 AND external_id = $2",
    [accountId, externalId, planId],
  );
  return rowCount === 1;
}

/**
 * One page in (created_at, id) order, served by users_account_created. Fetches limit + 1
 * rows to know whether another page exists without a COUNT.
 */
export async function listUsers(
  accountId: string,
  page: { limit: number; after: UserCursor | undefined },
  db: Queryable,
): Promise<{ users: UserListItem[]; next: UserCursor | null }> {
  const { rows } = await db.query<{
    id: string;
    external_id: string;
    created_at: Date;
    created_at_text: string;
    plan_id: string;
    plan_name: string;
  }>(
    `SELECT u.id, u.external_id, u.created_at,
            to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text,
            p.id AS plan_id, p.name AS plan_name
     FROM users u
     JOIN plans p ON p.id = u.plan_id
     WHERE u.account_id = $1
       AND ($2::timestamptz IS NULL OR (u.created_at, u.id) > ($2::timestamptz, $3::uuid))
     ORDER BY u.created_at, u.id
     LIMIT $4`,
    [accountId, page.after?.createdAt ?? null, page.after?.id ?? null, page.limit + 1],
  );

  const hasMore = rows.length > page.limit;
  const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
  const last = pageRows.at(-1);
  return {
    users: pageRows.map((r) => ({
      externalId: r.external_id,
      plan: { id: r.plan_id, name: r.plan_name },
      createdAt: r.created_at,
    })),
    next: hasMore && last ? { createdAt: last.created_at_text, id: last.id } : null,
  };
}

/**
 * The user plus both plans that apply to it (its own, and its account's), with rules, and
 * the current month, in one query. Consume reads exactly this inside its transaction.
 */
export async function findUserWithPlans(
  accountId: string,
  externalId: string,
  db: Queryable,
): Promise<UserWithPlans | undefined> {
  const { rows } = await db.query<{
    id: string;
    external_id: string;
    plan_id: string;
    created_at: Date;
    up_name: string;
    up_version: number;
    up_monthly: string | null;
    up_per_request: string | null;
    ap_id: string;
    ap_name: string;
    ap_version: number;
    ap_monthly: string | null;
    ap_per_request: string | null;
    month: string;
  }>(
    `SELECT u.id, u.external_id, u.plan_id, u.created_at,
            up.name AS up_name, up.version AS up_version,
            ur.monthly AS up_monthly, ur.per_request AS up_per_request,
            ap.id AS ap_id, ap.name AS ap_name, ap.version AS ap_version,
            ar.monthly AS ap_monthly, ar.per_request AS ap_per_request,
            to_char(date_trunc('month', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS month
     FROM users u
     JOIN accounts a ON a.id = u.account_id
     JOIN plans up ON up.id = u.plan_id
     JOIN plans ap ON ap.id = a.plan_id
     CROSS JOIN LATERAL (
       SELECT max("limit") FILTER (WHERE type = 'monthly_allowance')     AS monthly,
              max("limit") FILTER (WHERE type = 'max_units_per_request') AS per_request
       FROM plan_rules WHERE plan_id = up.id) ur
     CROSS JOIN LATERAL (
       SELECT max("limit") FILTER (WHERE type = 'monthly_allowance')     AS monthly,
              max("limit") FILTER (WHERE type = 'max_units_per_request') AS per_request
       FROM plan_rules WHERE plan_id = ap.id) ar
     WHERE u.account_id = $1 AND u.external_id = $2`,
    [accountId, externalId],
  );
  const r = rows[0];
  if (!r) return undefined;
  return {
    user: toUser(r),
    userPlan: {
      id: r.plan_id,
      name: r.up_name,
      version: r.up_version,
      rules: { monthlyAllowance: toLimit(r.up_monthly), maxUnitsPerRequest: toLimit(r.up_per_request) },
    },
    accountPlan: {
      id: r.ap_id,
      name: r.ap_name,
      version: r.ap_version,
      rules: { monthlyAllowance: toLimit(r.ap_monthly), maxUnitsPerRequest: toLimit(r.ap_per_request) },
    },
    month: r.month,
  };
}
