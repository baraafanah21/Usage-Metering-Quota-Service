import type { Pool } from "pg";
import { DEFAULT_ACCOUNT_PLAN_ID } from "../db/seed.js";
import { type Queryable, withTransaction } from "../db/tx.js";
import { generateApiKey } from "../domain/apiKeys.js";
import { AppError } from "../domain/errors.js";
import { type Account, findAccount, insertAccount, setAccountPlan } from "../repositories/accounts.js";
import { insertApiKey } from "../repositories/apiKeys.js";
import {
  findAccountPlan,
  findPredefinedPlan,
  findVisiblePlan,
  type Plan,
} from "../repositories/plans.js";
import { currentMonthUsage } from "../repositories/usage.js";
import { requirePlanScope } from "./plans.js";

export interface AccountWithPlan {
  account: Account;
  plan: Plan;
  /** Units accepted for the account in the current UTC month. */
  usage: { month: string; used: number };
}

export interface CreatedAccount extends AccountWithPlan {
  apiKey: { id: string; key: string; prefix: string; createdAt: Date };
}

async function loadAccountWithPlan(accountId: string, db: Queryable): Promise<AccountWithPlan> {
  const account = await findAccount(accountId, db);
  const plan = account && (await findAccountPlan(accountId, db));
  // A valid API key implies the account exists (FK), so this is a should-not-happen.
  if (!account || !plan) throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found");
  const { month, accountUsed } = await currentMonthUsage(accountId, null, db);
  return { account, plan, usage: { month, used: accountUsed } };
}

/** Creates the account and its first API key atomically: both exist, or neither does. */
export async function createAccount(
  pool: Pool,
  input: { name: string; planId?: string | undefined },
): Promise<CreatedAccount> {
  return withTransaction(pool, async (client) => {
    const planId = input.planId ?? DEFAULT_ACCOUNT_PLAN_ID;
    // Predefined only: a custom plan is owned by an account, so none can exist for this
    // account before it is created, and another account's plan is never assignable.
    const plan = requirePlanScope(await findPredefinedPlan(planId, client), planId, "account");
    const account = await insertAccount({ name: input.name, planId: plan.id }, client);
    const generated = generateApiKey();
    const record = await insertApiKey(account.id, generated, client);
    return {
      ...(await loadAccountWithPlan(account.id, client)),
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
    // Predefined or this account's own custom plan (invariant I7).
    const plan = requirePlanScope(await findVisiblePlan(accountId, planId, client), planId, "account");
    if (!(await setAccountPlan(accountId, plan.id, client))) {
      throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found");
    }
    return loadAccountWithPlan(accountId, client);
  });
}
