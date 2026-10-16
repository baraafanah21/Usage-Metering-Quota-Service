import type { Pool, PoolClient } from "pg";

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pick<Pool | PoolClient, "query">;

/** Where one transaction's time went, in seconds. */
export interface TxTiming {
  /** Waiting for a pool connection, before BEGIN. */
  acquire: number;
  /** BEGIN to COMMIT/ROLLBACK on the acquired connection. */
  tx: number;
}

/**
 * Runs fn inside BEGIN/COMMIT on one client. Any throw rolls back and is rethrown.
 * The client is always released; if ROLLBACK itself fails the connection is broken,
 * so it is destroyed instead of being returned to the pool.
 * `observe`, if given, receives the timing once the transaction has ended either way.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  observe?: (timing: TxTiming) => void,
): Promise<T> {
  const requested = performance.now();
  const client = await pool.connect();
  const acquired = performance.now();
  let broken: Error | undefined;
  // pg-pool removes its own 'error' listener while a client is checked out. If the server ends
  // the session mid-transaction (restart, pg_terminate_backend), pg rejects the running query
  // AND emits 'error'; with no listener that emit is an uncaught exception that kills the
  // process. The rejected query already reports the failure, so only mark the client broken.
  const onError = (err: Error) => {
    broken = err;
  };
  client.on("error", onError);
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
    client.removeListener("error", onError);
    client.release(broken);
    observe?.({ acquire: (acquired - requested) / 1000, tx: (performance.now() - acquired) / 1000 });
  }
}
