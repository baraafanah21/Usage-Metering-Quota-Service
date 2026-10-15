import type { Pool } from "pg";
import { isUniqueViolation } from "../db/errors.js";
import { DEFAULT_USER_PLAN_ID } from "../db/seed.js";
import type { Queryable } from "../db/tx.js";
import { AppError } from "../domain/errors.js";
import { remaining, toRules } from "../domain/rules.js";
import { findVisiblePlan, type Plan } from "../repositories/plans.js";
import { currentMonthUsage } from "../repositories/usage.js";
import {
  findUser,
  findUserWithPlans,
  insertUser,
  listUsers as listUserRows,
  type PlanRef,
  setUserPlan,
  type User,
  type UserCursor,
  type UserListItem,
} from "../repositories/users.js";
import { requirePlanScope } from "./plans.js";

const USER_UNIQUE = "users_account_id_external_id_key";

export interface UserWithPlan {
  user: User;
  plan: Plan;
}

export interface LevelLimits {
  planId: string;
  planName: string;
  planVersion: number;
  monthlyAllowance: number | null;
  maxUnitsPerRequest: number | null;
  used: number;
  remaining: number | null;
}

export interface EffectiveLimits {
  month: string;
  account: LevelLimits;
  user: LevelLimits;
}

export const userNotFound = (externalId: string) =>
  new AppError(404, "USER_NOT_FOUND", "User not found", `No user '${externalId}' in this account`);

/** A predefined or this account's own custom plan, and it must be user-scope (invariant I7). */
async function resolveUserPlan(accountId: string, planId: string, db: Queryable): Promise<Plan> {
  return requirePlanScope(await findVisiblePlan(accountId, planId, db), planId, "user");
}

export async function createUser(
  pool: Pool,
  accountId: string,
  input: { externalId: string; planId?: string | undefined },
): Promise<UserWithPlan> {
  // No transaction needed: plans are never deleted and their scope never changes, so the
  // plan checked here is still valid when the insert runs.
  const plan = await resolveUserPlan(accountId, input.planId ?? DEFAULT_USER_PLAN_ID, pool);
  try {
    const user = await insertUser(accountId, { externalId: input.externalId, planId: plan.id }, pool);
    return { user, plan };
  } catch (err) {
    if (isUniqueViolation(err, USER_UNIQUE)) {
      throw new AppError(
        409,
        "USER_ALREADY_EXISTS",
        "User already exists",
        `A user '${input.externalId}' already exists in this account`,
      );
    }
    throw err;
  }
}

export async function getUser(pool: Pool, accountId: string, externalId: string): Promise<UserWithPlan> {
  const user = await findUser(accountId, externalId, pool);
  if (!user) throw userNotFound(externalId);
  const plan = await findVisiblePlan(accountId, user.planId, pool);
  // The FK guarantees the plan exists, and I7 that this account can see it.
  if (!plan) throw new Error(`User ${user.id} has plan ${user.planId} not visible to its account`);
  return { user, plan };
}

export function listUsers(
  pool: Pool,
  accountId: string,
  page: { limit: number; after: UserCursor | undefined },
): Promise<{ users: UserListItem[]; next: UserCursor | null }> {
  return listUserRows(accountId, page, pool);
}

/** Changes only which plan applies. Usage counters are untouched, so consumed units carry over. */
export async function assignUserPlan(
  pool: Pool,
  accountId: string,
  externalId: string,
  planId: string,
): Promise<UserWithPlan> {
  // The user in the URL is checked first: an unknown user is 404 whatever the body says.
  const user = await findUser(accountId, externalId, pool);
  if (!user) throw userNotFound(externalId);
  const plan = await resolveUserPlan(accountId, planId, pool);
  if (!(await setUserPlan(accountId, externalId, plan.id, pool))) throw userNotFound(externalId);
  return { user: { ...user, planId: plan.id }, plan };
}

export function levelLimits(plan: PlanRef, used: number): LevelLimits {
  const rules = toRules(plan.rules);
  return {
    planId: plan.id,
    planName: plan.name,
    planVersion: plan.version,
    monthlyAllowance: plan.rules.monthlyAllowance,
    maxUnitsPerRequest: plan.rules.maxUnitsPerRequest,
    used,
    remaining: remaining(rules.monthlyAllowance, used),
  };
}

/**
 * What the user could consume right now: both plans and both counters for the current month.
 * Two queries regardless of data size: user + both plans' rules, then both counters.
 */
export async function getEffectiveLimits(
  pool: Pool,
  accountId: string,
  externalId: string,
): Promise<EffectiveLimits> {
  const found = await findUserWithPlans(accountId, externalId, pool);
  if (!found) throw userNotFound(externalId);
  const usage = await currentMonthUsage(accountId, found.user.id, pool);
  return {
    month: usage.month,
    account: levelLimits(found.accountPlan, usage.accountUsed),
    user: levelLimits(found.userPlan, usage.userUsed),
  };
}
