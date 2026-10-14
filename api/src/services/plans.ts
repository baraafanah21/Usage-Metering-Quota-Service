import type { Pool } from "pg";
import { isUniqueViolation } from "../db/errors.js";
import { type Queryable, withTransaction } from "../db/tx.js";
import { AppError } from "../domain/errors.js";
import {
  applyRules,
  countAssignments,
  findVisiblePlan,
  insertCustomPlan,
  listVisiblePlans,
  lockVisiblePlan,
  type Plan,
  type PlanAssignments,
  type PlanScope,
  type RulesPatch,
  touchCustomPlan,
} from "../repositories/plans.js";

// The partial unique index from 001_init.sql: (owner_account_id, scope, lower(name)).
const CUSTOM_NAME_INDEX = "plans_owner_scope_name";

export const planNotFound = (planId: string) =>
  new AppError(404, "PLAN_NOT_FOUND", "Plan not found", `No plan with id '${planId}'`);

function nameTaken(name: string, scope: PlanScope): AppError {
  return new AppError(
    409,
    "PLAN_NAME_TAKEN",
    "Plan name already taken",
    `This account already has a ${scope} plan named '${name}'`,
  );
}

/** Runs a write and turns a violation of the plan-name index into 409 PLAN_NAME_TAKEN. */
async function mapNameConflict<T>(name: string, scope: PlanScope, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (isUniqueViolation(err, CUSTOM_NAME_INDEX)) throw nameTaken(name, scope);
    throw err;
  }
}

/**
 * Checks that a looked-up plan can be assigned at the given level. A plan the account
 * can't see (unknown, or another account's custom plan) is 404, so other tenants' plan ids
 * reveal nothing; a visible plan of the other scope is 400.
 */
export function requirePlanScope(plan: Plan | undefined, planId: string, scope: PlanScope): Plan {
  if (!plan) throw planNotFound(planId);
  if (plan.scope !== scope) {
    const a = (s: PlanScope) => (s === "account" ? "an" : "a");
    throw new AppError(
      400,
      "INVALID_PLAN_SCOPE",
      "Plan has the wrong scope",
      `'${plan.name}' is ${a(plan.scope)} ${plan.scope} plan; ${a(scope)} ${scope} needs ${a(scope)} ${scope} plan`,
    );
  }
  return plan;
}

async function loadVisiblePlan(accountId: string, planId: string, db: Queryable): Promise<Plan> {
  const plan = await findVisiblePlan(accountId, planId, db);
  if (!plan) throw planNotFound(planId);
  return plan;
}

export function listPlans(pool: Pool, accountId: string, scope?: PlanScope): Promise<Plan[]> {
  return listVisiblePlans(accountId, scope, pool);
}

export async function getPlan(
  pool: Pool,
  accountId: string,
  planId: string,
): Promise<{ plan: Plan; assignments: PlanAssignments }> {
  const plan = await loadVisiblePlan(accountId, planId, pool);
  return { plan, assignments: await countAssignments(accountId, planId, pool) };
}

/** Inserts the plan and its rules in one transaction: a plan never exists without its rules. */
export async function createPlan(
  pool: Pool,
  accountId: string,
  input: { name: string; scope: PlanScope; rules: RulesPatch },
): Promise<Plan> {
  return withTransaction(pool, async (client) => {
    const planId = await mapNameConflict(input.name, input.scope, () =>
      insertCustomPlan(accountId, { name: input.name, scope: input.scope }, client),
    );
    await applyRules(planId, input.rules, client);
    return loadVisiblePlan(accountId, planId, client);
  });
}

/**
 * Updates an owned custom plan under a row lock: concurrent PATCHes queue on the lock, and
 * each one adds exactly 1 to the version. The new rules apply to every account and user on
 * the plan from the next request (they are read inside each consume transaction, §6.5).
 */
export async function updatePlan(
  pool: Pool,
  accountId: string,
  planId: string,
  patch: { name?: string | undefined; rules?: RulesPatch | undefined },
): Promise<Plan> {
  return withTransaction(pool, async (client) => {
    const locked = await lockVisiblePlan(accountId, planId, client);
    if (!locked) throw planNotFound(planId);
    if (locked.ownerAccountId === null) {
      throw new AppError(403, "PLAN_READ_ONLY", "Plan is read-only", "Predefined plans cannot be changed");
    }

    // A name conflict is only possible when renaming, i.e. when patch.name is set.
    await mapNameConflict(patch.name ?? "", locked.scope, () =>
      touchCustomPlan(accountId, planId, patch.name, client),
    );
    if (patch.rules) await applyRules(planId, patch.rules, client);
    return loadVisiblePlan(accountId, planId, client);
  });
}
