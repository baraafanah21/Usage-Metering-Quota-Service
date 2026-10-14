import type { Plan } from "../repositories/plans.js";
import type { AccountWithPlan } from "../services/accounts.js";

// JSON shapes returned by the API. Kept separate from repository types so a column
// rename never silently changes the public contract.

export function planView(plan: Plan) {
  return {
    id: plan.id,
    name: plan.name,
    scope: plan.scope,
    version: plan.version,
    predefined: plan.ownerAccountId === null,
    rules: plan.rules,
  };
}

export function accountView({ account, plan }: AccountWithPlan) {
  return {
    id: account.id,
    name: account.name,
    createdAt: account.createdAt.toISOString(),
    plan: planView(plan),
  };
}
