import { remaining, toRules } from "../domain/rules.js";
import type { Plan, PlanAssignments } from "../repositories/plans.js";
import type { UserListItem } from "../repositories/users.js";
import type { AccountWithPlan } from "../services/accounts.js";
import type { UserWithPlan } from "../services/users.js";

// JSON shapes returned by the API. Kept separate from repository types so a column
// rename never silently changes the public contract.

export function planView(plan: Plan) {
  return {
    id: plan.id,
    name: plan.name,
    scope: plan.scope,
    predefined: plan.ownerAccountId === null,
    version: plan.version,
    rules: plan.rules,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

export function planDetailView(plan: Plan, assignments: PlanAssignments) {
  return { ...planView(plan), assignments };
}

export function accountView({ account, plan, usage }: AccountWithPlan) {
  return {
    id: account.id,
    name: account.name,
    createdAt: account.createdAt.toISOString(),
    plan: planView(plan),
    currentMonth: {
      month: usage.month,
      used: usage.used,
      remaining: remaining(toRules(plan.rules).monthlyAllowance, usage.used),
    },
  };
}

export function userView({ user, plan }: UserWithPlan) {
  return {
    externalId: user.externalId,
    createdAt: user.createdAt.toISOString(),
    plan: planView(plan),
  };
}

export function userListItemView(item: UserListItem) {
  return {
    externalId: item.externalId,
    createdAt: item.createdAt.toISOString(),
    plan: item.plan,
  };
}
