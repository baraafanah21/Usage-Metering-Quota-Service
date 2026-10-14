import type { Queryable } from "../db/tx.js";

export type PlanScope = "account" | "user";

export interface PlanRules {
  /** null = no rule of this type = unlimited at this level. */
  monthlyAllowance: number | null;
  maxUnitsPerRequest: number | null;
}

export interface Plan {
  id: string;
  name: string;
  scope: PlanScope;
  version: number;
  /** null for predefined (global, read-only) plans. */
  ownerAccountId: string | null;
  rules: PlanRules;
}

interface PlanRow {
  id: string;
  name: string;
  scope: PlanScope;
  version: number;
  owner_account_id: string | null;
  monthly_allowance: string | null; // bigint arrives as a string
  max_units_per_request: string | null;
}

// One row per plan, rules pivoted into columns. Shared by every plan lookup.
const PLAN_SELECT = `
  SELECT p.id, p.name, p.scope, p.version, p.owner_account_id,
         max(r."limit") FILTER (WHERE r.type = 'monthly_allowance')     AS monthly_allowance,
         max(r."limit") FILTER (WHERE r.type = 'max_units_per_request') AS max_units_per_request
  FROM plans p
  LEFT JOIN plan_rules r ON r.plan_id = p.id`;

function toPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    version: row.version,
    ownerAccountId: row.owner_account_id,
    rules: {
      monthlyAllowance: row.monthly_allowance === null ? null : Number(row.monthly_allowance),
      maxUnitsPerRequest:
        row.max_units_per_request === null ? null : Number(row.max_units_per_request),
    },
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
