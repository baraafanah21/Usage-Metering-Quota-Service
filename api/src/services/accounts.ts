import type { Pool } from "pg";
import { DEFAULT_ACCOUNT_PLAN_ID } from "../db/seed.js";
import { type Queryable, withTransaction } from "../db/tx.js";
import { generateApiKey } from "../domain/apiKeys.js";
import { AppError } from "../domain/errors.js";
import { type Account, findAccount, insertAccount, setAccountPlan } from "../repositories/accounts.js";
import { insertApiKey } from "../repositories/apiKeys.js";
import { findAccountPlan, findPredefinedPlan, type Plan } from "../repositories/plans.js";

export interface AccountWithPlan {
  account: Account;
  plan: Plan;
}

export interface CreatedAccount extends AccountWithPlan {
  apiKey: { id: string; key: string; prefix: string; createdAt: Date };
}

/**
 * The plan an account may be put on. Only predefined account plans for now.
 * TODO(phase 2b): also accept custom account plans owned by this account.
 */
async function resolveAccountPlan(planId: string, db: Queryable): Promise<Plan> {
  const plan = await findPredefinedPlan(planId, db);
  if (!plan) {
    throw new AppError(404, "PLAN_NOT_FOUND", "Plan not found", `No plan with id '${planId}'`);
  }
  if (plan.scope !== "account") {
    throw new AppError(
      400,
      "INVALID_PLAN_SCOPE",
      "Plan has the wrong scope",
      `'${plan.name}' is a ${plan.scope} plan; an account needs an account plan`,
    );
  }
  return plan;
}

async function loadAccountWithPlan(accountId: string, db: Queryable): Promise<AccountWithPlan> {
  const account = await findAccount(accountId, db);
  const plan = account && (await findAccountPlan(accountId, db));
  // A valid API key implies the account exists (FK), so this is a should-not-happen.
  if (!account || !plan) throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found");
  return { account, plan };
}

/** Creates the account and its first API key atomically: both exist, or neither does. */
export async function createAccount(
  pool: Pool,
  input: { name: string; planId?: string | undefined },
): Promise<CreatedAccount> {
  return withTransaction(pool, async (client) => {
    const plan = await resolveAccountPlan(input.planId ?? DEFAULT_ACCOUNT_PLAN_ID, client);
    const account = await insertAccount({ name: input.name, planId: plan.id }, client);
    const generated = generateApiKey();
    const record = await insertApiKey(account.id, generated, client);
    return {
      account,
      plan,
      apiKey: {
        id: record.id,
        key: generated.key,
        prefix: record.keyPrefix,
        createdAt: record.createdAt,
      },
    };
  });
}

export async function getAccount(pool: Pool, accountId: string): Promise<AccountWithPlan> {
  return loadAccountWithPlan(accountId, pool);
}

/** Switching plans never touches usage counters: consumed units carry over (§6.5). */
export async function assignAccountPlan(
  pool: Pool,
  accountId: string,
  planId: string,
): Promise<AccountWithPlan> {
  return withTransaction(pool, async (client) => {
    const plan = await resolveAccountPlan(planId, client);
    if (!(await setAccountPlan(accountId, plan.id, client))) {
      throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found");
    }
    return loadAccountWithPlan(accountId, client);
  });
}
