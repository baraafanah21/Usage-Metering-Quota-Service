import pg from "pg";
import type { Logger } from "pino";

export interface PoolOptions {
  connectionString: string;
  max: number;
}

/** One bounded pool per process. Callers wait in pg's queue when all connections are busy. */
export function createPool(options: PoolOptions, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  // An idle client losing its connection emits 'error' on the pool; without a listener
  // Node treats it as an unhandled error and crashes the process.
  pool.on("error", (err) => {
    logger.error({ err }, "idle database client error");
  });

  return pool;
}
