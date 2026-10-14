import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";
import type { Logger } from "pino";

// Works from both src/ (tsx, tests) and dist/ (the build copies the .sql files next to it).
const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);

// Arbitrary constant shared by every instance; the session-level lock on it serializes migrators.
const MIGRATION_LOCK_KEY = 727_001;

const FILE_PATTERN = /^(\d+)_[\w-]+\.sql$/;

export interface Migration {
  version: number;
  name: string;
}

let cached: Migration[] | undefined;

/** Migration files on disk, sorted by version. Read once per process. */
export function listMigrations(): Migration[] {
  if (cached) return cached;
  const migrations = readdirSync(MIGRATIONS_DIR)
    .flatMap((name) => {
      const match = FILE_PATTERN.exec(name);
      return match ? [{ version: Number(match[1]), name }] : [];
    })
    .sort((a, b) => a.version - b.version);

  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i]!.version === migrations[i - 1]!.version) {
      throw new Error(`Duplicate migration version ${migrations[i]!.version}`);
    }
  }
  cached = migrations;
  return migrations;
}

export function latestMigrationVersion(): number {
  return listMigrations().at(-1)?.version ?? 0;
}

export interface RetryOptions {
  attempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryOptions = { attempts: 10, initialDelayMs: 250, maxDelayMs: 5_000 };

/** Gets a client, retrying with exponential backoff while Postgres is still starting (§10). */
export async function connectWithRetry(
  pool: Pool,
  logger: Logger,
  { attempts, initialDelayMs, maxDelayMs }: RetryOptions = DEFAULT_RETRY,
): Promise<PoolClient> {
  let delay = initialDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await pool.connect();
    } catch (err) {
      if (attempt >= attempts) throw err;
      logger.warn({ err, attempt, retryInMs: delay }, "database not reachable, retrying");
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}

/**
 * Applies pending migrations in version order, each in its own transaction.
 * Holds an advisory lock for the whole run so concurrent instances wait instead of
 * racing; whoever gets the lock second finds nothing left to do. Safe to run repeatedly.
 */
export async function migrate(
  pool: Pool,
  logger: Logger,
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<void> {
  const client = await connectWithRetry(pool, logger, retry);
  let failed = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    int PRIMARY KEY,
        name       text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<{ version: number }>("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.version));

    for (const migration of listMigrations()) {
      if (applied.has(migration.version)) continue;
      const sql = readFileSync(new URL(migration.name, MIGRATIONS_DIR), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
          migration.version,
          migration.name,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        // Best effort: the connection is destroyed below either way.
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`Migration ${migration.name} failed`, { cause: err });
      }
      logger.info({ migration: migration.name }, "applied migration");
    }

    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    // On failure, destroy the connection rather than unlocking: closing the session drops
    // the advisory lock, and a possibly broken connection must not go back into the pool.
    client.release(failed);
  }
}
