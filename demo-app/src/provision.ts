import type { Account, CreatedAccount, Plan } from "./api-types.js";
import { MeteringClient, MeteringError } from "./metering.js";

// Operator-side setup. Every step is idempotent: a 409 means "already exists" and the
// existing object is looked up instead, so running it again creates nothing new.

/** Predefined user plans (fixed ids from api/src/db/seed.ts). */
export const BASIC_PLAN_ID = "00000000-0000-4000-8000-00000000b001";
export const PREMIUM_PLAN_ID = "00000000-0000-4000-8000-00000000b002";

export const DEMO_TEAM = {
  name: "Demo Team",
  scope: "account",
  rules: { monthlyAllowance: 60, maxUnitsPerRequest: 50 },
} as const;

export const DEMO_USERS = [
  { externalId: "alice", planId: BASIC_PLAN_ID },
  { externalId: "bob", planId: PREMIUM_PLAN_ID },
  { externalId: "carol", planId: BASIC_PLAN_ID },
] as const;

export interface CreatedDemoAccount {
  accountId: string;
  apiKey: string;
}

/** Operator call: a new account on the default plan. The key is returned once, here only. */
export async function createAccount(admin: MeteringClient, name: string): Promise<CreatedDemoAccount> {
  const created = await admin.json<CreatedAccount>("POST", "/v1/admin/accounts", { name });
  return { accountId: created.account.id, apiKey: created.apiKey.key };
}

const isConflict = (err: unknown, code: string) => err instanceof MeteringError && err.code === code;

async function ensureDemoTeamPlan(api: MeteringClient): Promise<Plan> {
  try {
    return await api.json<Plan>("POST", "/v1/plans", DEMO_TEAM);
  } catch (err) {
    if (!isConflict(err, "PLAN_NAME_TAKEN")) throw err;
    const { plans } = await api.json<{ plans: Plan[] }>("GET", "/v1/plans?scope=account");
    // Names are unique per account and scope, case-insensitively (§8.1 PLAN_NAME_TAKEN).
    const existing = plans.find((p) => !p.predefined && p.name.toLowerCase() === DEMO_TEAM.name.toLowerCase());
    if (!existing) throw new Error("PLAN_NAME_TAKEN for Demo Team, but no such plan is listed");
    return existing;
  }
}

/**
 * Brings an account to the demo's starting shape: Demo Team as its account plan and
 * alice/bob/carol registered. Objects that already exist are left as they are, so a
 * restart keeps any limit or plan changes made in free play.
 */
export async function setUpDemoAccount(api: MeteringClient): Promise<{ demoTeamPlanId: string }> {
  const plan = await ensureDemoTeamPlan(api);

  const account = await api.json<Account>("GET", "/v1/account");
  if (account.plan.id !== plan.id) {
    await api.call("PUT", "/v1/account/plan", { planId: plan.id });
  }

  for (const user of DEMO_USERS) {
    try {
      await api.call("POST", "/v1/users", user);
    } catch (err) {
      if (!isConflict(err, "USER_ALREADY_EXISTS")) throw err;
    }
  }

  return { demoTeamPlanId: plan.id };
}
