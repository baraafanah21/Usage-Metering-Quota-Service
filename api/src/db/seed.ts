import type { Pool } from "pg";
import type { Logger } from "pino";
import { withTransaction } from "./tx.js";

/** Fixed ids so restarts are idempotent and the demo/tests can refer to plans directly. */
export const PLAN_IDS = {
  starter: "00000000-0000-4000-8000-00000000a001",
  pro: "00000000-0000-4000-8000-00000000a002",
  basic: "00000000-0000-4000-8000-00000000b001",
  premium: "00000000-0000-4000-8000-00000000b002",
} as const;

export const DEFAULT_ACCOUNT_PLAN_ID = PLAN_IDS.starter;
export const DEFAULT_USER_PLAN_ID = PLAN_IDS.basic;

interface PredefinedPlan {
  id: string;
  scope: "account" | "user";
  name: string;
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
}

// DESIGN.md §9
const PREDEFINED_PLANS: PredefinedPlan[] = [
  { id: PLAN_IDS.starter, scope: "account", name: "Starter", monthlyAllowance: 10_000, maxUnitsPerRequest: 100 },
  { id: PLAN_IDS.pro, scope: "account", name: "Pro", monthlyAllowance: 100_000, maxUnitsPerRequest: 500 },
  { id: PLAN_IDS.basic, scope: "user", name: "Basic", monthlyAllowance: 1_000, maxUnitsPerRequest: 20 },
  { id: PLAN_IDS.premium, scope: "user", name: "Premium", monthlyAllowance: 5_000, maxUnitsPerRequest: 100 },
];

/**
 * Inserts the predefined plans and their rules. ON CONFLICT DO NOTHING makes it safe to
 * run on every startup; existing rows are never modified (predefined plans are read-only).
 */
export async function seed(pool: Pool, logger: Logger): Promise<void> {
  await withTransaction(pool, async (client) => {
    for (const plan of PREDEFINED_PLANS) {
      await client.query(
        `INSERT INTO plans (id, owner_account_id, scope, name)
         VALUES ($1, NULL, $2, $3)
         ON CONFLICT DO NOTHING`,
        [plan.id, plan.scope, plan.name],
      );
      await client.query(
        `INSERT INTO plan_rules (plan_id, type, "limit")
         VALUES ($1, 'monthly_allowance', $2), ($1, 'max_units_per_request', $3)
         ON CONFLICT DO NOTHING`,
        [plan.id, plan.monthlyAllowance, plan.maxUnitsPerRequest],
      );
    }
  });
  logger.info({ plans: PREDEFINED_PLANS.length }, "seeded predefined plans");
}
