import type { Queryable } from "../db/tx.js";

export interface Account {
  id: string;
  name: string;
  planId: string;
  createdAt: Date;
}

interface AccountRow {
  id: string;
  name: string;
  plan_id: string;
  created_at: Date;
}

function toAccount(row: AccountRow): Account {
  return { id: row.id, name: row.name, planId: row.plan_id, createdAt: row.created_at };
}

/** Creates a new tenant. The id is generated here, so there is no accountId to scope by yet. */
export async function insertAccount(
  input: { name: string; planId: string },
  db: Queryable,
): Promise<Account> {
  const { rows } = await db.query<AccountRow>(
    `INSERT INTO accounts (name, plan_id) VALUES ($1, $2)
     RETURNING id, name, plan_id, created_at`,
    [input.name, input.planId],
  );
  return toAccount(rows[0]!);
}

export async function findAccount(accountId: string, db: Queryable): Promise<Account | undefined> {
  const { rows } = await db.query<AccountRow>(
    "SELECT id, name, plan_id, created_at FROM accounts WHERE id = $1",
    [accountId],
  );
  return rows[0] && toAccount(rows[0]);
}

/** Returns false if the account does not exist. */
export async function setAccountPlan(
  accountId: string,
  planId: string,
  db: Queryable,
): Promise<boolean> {
  const { rowCount } = await db.query("UPDATE accounts SET plan_id = $2 WHERE id = $1", [
    accountId,
    planId,
  ]);
  return rowCount === 1;
}
