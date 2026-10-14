import type { Queryable } from "../db/tx.js";

export interface ApiKeyRecord {
  id: string;
  accountId: string;
  keyPrefix: string;
  createdAt: Date;
}

/** Stores only the hash and display prefix; the plaintext key never reaches the database. */
export async function insertApiKey(
  accountId: string,
  input: { hash: Buffer; displayPrefix: string },
  db: Queryable,
): Promise<ApiKeyRecord> {
  const { rows } = await db.query<{ id: string; key_prefix: string; created_at: Date }>(
    `INSERT INTO api_keys (account_id, key_hash, key_prefix) VALUES ($1, $2, $3)
     RETURNING id, key_prefix, created_at`,
    [accountId, input.hash, input.displayPrefix],
  );
  const row = rows[0]!;
  return { id: row.id, accountId, keyPrefix: row.key_prefix, createdAt: row.created_at };
}

/**
 * Resolves a key hash to its account. This is how the tenant is discovered, so it can't be
 * scoped by accountId. Unknown and revoked keys both return undefined (one query, same path).
 */
export async function findAccountIdByKeyHash(
  hash: Buffer,
  db: Queryable,
): Promise<string | undefined> {
  const { rows } = await db.query<{ account_id: string }>(
    "SELECT account_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
    [hash],
  );
  return rows[0]?.account_id;
}
