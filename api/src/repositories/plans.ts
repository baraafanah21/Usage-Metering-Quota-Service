import type { Queryable } from "../db/tx.js";

export type PlanScope = "account" | "user";
export type RuleType = "monthly_allowance" | "max_units_per_request";

export interface PlanRules {
  /** null = no rule of this type = unlimited at this level. */
  monthlyAllowance: number | null;
  maxUnitsPerRequest: number | null;
}

/** A partial rule change: a number sets the rule, null removes it, a missing key leaves it. */
export type RulesPatch = { [K in keyof PlanRules]?: PlanRules[K] | undefined };

export interface Plan {
  id: string;
  name: string;
  scope: PlanScope;
  version: number;
  /** null for predefined (global, read-only) plans. */
  ownerAccountId: string | null;
  rules: PlanRules;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlanAssignments {
  /** 0 or 1: whether the account itself is on this plan. */
  accounts: number;
  users: number;
}

const RULE_TYPES: Record<keyof PlanRules, RuleType> = {
  monthlyAllowance: "monthly_allowance",
  maxUnitsPerRequest: "max_units_per_request",
};

interface PlanRow {
  id: string;
  name: string;
  scope: PlanScope;
  version: number;
  owner_account_id: string | null;
  created_at: Date;
  updated_at: Date;
  monthly_allowance: string | null; // bigint arrives as a string
  max_units_per_request: string | null;
}

// One row per plan, rules pivoted into columns. Shared by every plan lookup.
const PLAN_SELECT = `
  SELECT p.id, p.name, p.scope, p.version, p.owner_account_id, p.created_at, p.updated_at,
         max(r."limit") FILTER (WHERE r.type = 'monthly_allowance')     AS monthly_allowance,
         max(r."limit") FILTER (WHERE r.type = 'max_units_per_request') AS max_units_per_request
  FROM plans p
  LEFT JOIN plan_rules r ON r.plan_id = p.id`;

// Limits are validated as safe integers on the way in, so Number() is exact.
const toLimit = (value: string | null) => (value === null ? null : Number(value));

function toPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    version: row.version,
    ownerAccountId: row.owner_account_id,
    rules: {
      monthlyAllowance: toLimit(row.monthly_allowance),
      maxUnitsPerRequest: toLimit(row.max_units_per_request),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The plan currently assigned to the account. */
export async function findAccountPlan(accountId: string, db: Queryable): Promise<Plan | undefined> {
  const { rows } = await db.query<PlanRow>(
    `${PLAN_SELECT}
     JOIN accounts a ON a.plan_id = p.id
     WHERE a.id = $1
     GROUP BY p.id`,
    [accountId],
  );
  return rows[0] && toPlan(rows[0]);
}

/** A predefined plan by id. Not tenant-owned, so no accountId. */
export async function findPredefinedPlan(planId: string, db: Queryable): Promise<Plan | undefined> {
  const { rows } = await db.query<PlanRow>(
    `${PLAN_SELECT}
     WHERE p.id = $1 AND p.owner_account_id IS NULL
     GROUP BY p.id`,
    [planId],
  );
  return rows[0] && toPlan(rows[0]);
}

/** A plan the account may see: any predefined plan, or a custom plan it owns. */
export async function findVisiblePlan(
  accountId: string,
  planId: string,
  db: Queryable,
): Promise<Plan | undefined> {
  const { rows } = await db.query<PlanRow>(
    `${PLAN_SELECT}
     WHERE p.id = $2 AND (p.owner_account_id IS NULL OR p.owner_account_id = $1)
     GROUP BY p.id`,
    [accountId, planId],
  );
  return rows[0] && toPlan(rows[0]);
}

/**
 * Predefined plans first, then the account's own custom plans, oldest first.
 * Not paginated: plans are configuration created by hand, not data that grows per request.
 */
export async function listVisiblePlans(
  accountId: string,
  scope: PlanScope | undefined,
  db: Queryable,
): Promise<Plan[]> {
  const { rows } = await db.query<PlanRow>(
    `${PLAN_SELECT}
     WHERE (p.owner_account_id IS NULL OR p.owner_account_id = $1)
       AND ($2::plan_scope IS NULL OR p.scope = $2)
     GROUP BY p.id
     ORDER BY p.owner_account_id IS NOT NULL, p.created_at, p.id`,
    [accountId, scope ?? null],
  );
  return rows.map(toPlan);
}

/**
 * Locks a visible plan row (FOR UPDATE) until the transaction ends, so concurrent edits of
 * one plan run one after another. Returns its owner (null = predefined, read-only) and scope.
 */
export async function lockVisiblePlan(
  accountId: string,
  planId: string,
  db: Queryable,
): Promise<{ ownerAccountId: string | null; scope: PlanScope } | undefined> {
  const { rows } = await db.query<{ owner_account_id: string | null; scope: PlanScope }>(
    `SELECT owner_account_id, scope FROM plans
     WHERE id = $2 AND (owner_account_id IS NULL OR owner_account_id = $1)
     FOR UPDATE`,
    [accountId, planId],
  );
  return rows[0] && { ownerAccountId: rows[0].owner_account_id, scope: rows[0].scope };
}

/** Inserts a custom plan owned by the account. A taken name raises unique_violation (23505). */
export async function insertCustomPlan(
  accountId: string,
  input: { name: string; scope: PlanScope },
  db: Queryable,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO plans (owner_account_id, scope, name) VALUES ($1, $2, $3) RETURNING id",
    [accountId, input.scope, input.name],
  );
  return rows[0]!.id;
}

/**
 * Renames (if name is given) and bumps the version of an owned custom plan. The increment
 * happens in SQL on the locked row, so concurrent updates can never lose a bump.
 */
export async function touchCustomPlan(
  accountId: string,
  planId: string,
  name: string | undefined,
  db: Queryable,
): Promise<void> {
  await db.query(
    `UPDATE plans
     SET name = COALESCE($3, name), version = version + 1, updated_at = now()
     WHERE id = $2 AND owner_account_id = $1`,
    [accountId, planId, name ?? null],
  );
}

/**
 * Applies a rules patch to a plan: numbers upsert, nulls delete, missing keys are skipped.
 * Callers must already have checked that the account owns the plan.
 */
export async function applyRules(planId: string, rules: RulesPatch, db: Queryable): Promise<void> {
  for (const [key, type] of Object.entries(RULE_TYPES) as [keyof PlanRules, RuleType][]) {
    const value = rules[key];
    if (value === undefined) continue;
    if (value === null) {
      await db.query("DELETE FROM plan_rules WHERE plan_id = $1 AND type = $2", [planId, type]);
    } else {
      await db.query(
        `INSERT INTO plan_rules (plan_id, type, "limit") VALUES ($1, $2, $3)
         ON CONFLICT (plan_id, type) DO UPDATE SET "limit" = EXCLUDED."limit"`,
        [planId, type, value],
      );
    }
  }
}

/** How many of this account's own entities (the account, its users) are on the plan. */
export async function countAssignments(
  accountId: string,
  planId: string,
  db: Queryable,
): Promise<PlanAssignments> {
  const { rows } = await db.query<PlanAssignments>(
    `SELECT
       (SELECT count(*) FROM accounts WHERE id = $1 AND plan_id = $2)::int         AS accounts,
       (SELECT count(*) FROM users WHERE account_id = $1 AND plan_id = $2)::int    AS users`,
    [accountId, planId],
  );
  return rows[0]!;
}
