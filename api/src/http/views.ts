import type { Plan, PlanAssignments } from "../repositories/plans.js";
import type { AccountWithPlan } from "../services/accounts.js";

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

export function accountView({ account, plan }: AccountWithPlan) {
  return {
    id: account.id,
    name: account.name,
    createdAt: account.createdAt.toISOString(),
    plan: planView(plan),
  };
}
