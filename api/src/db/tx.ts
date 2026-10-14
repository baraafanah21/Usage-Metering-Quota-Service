import type { Pool, PoolClient } from "pg";

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * Runs fn inside BEGIN/COMMIT on one client. Any throw rolls back and is rethrown.
 * The client is always released; if ROLLBACK itself fails the connection is broken,
 * so it is destroyed instead of being returned to the pool.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
