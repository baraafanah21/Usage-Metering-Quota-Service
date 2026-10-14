import { Router } from "express";
import type { Pool } from "pg";
import { latestMigrationVersion } from "../../db/migrate.js";
import { AppError } from "../../domain/errors.js";

const UNDEFINED_TABLE = "42P01";

export function healthRouter(pool: Pool): Router {
  const router = Router();
  const expectedVersion = latestMigrationVersion();

  // Liveness: the process is up and the event loop answers. Never touches the database,
  // so a database outage doesn't get the container restarted.
  router.get("/live", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Readiness: the database answers and has the schema this build expects (§12).
  router.get("/ready", async (_req, res) => {
    let migrated: boolean;
    try {
      const { rowCount } = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [
        expectedVersion,
      ]);
      migrated = rowCount === 1;
    } catch (err) {
      if ((err as { code?: string }).code === UNDEFINED_TABLE) {
        migrated = false; // reachable, but the runner hasn't created schema_migrations yet
      } else {
        // The error middleware logs it (with the cause) as a 5xx.
        throw new AppError(503, "SERVICE_UNAVAILABLE", "Database unavailable", undefined, {
          cause: err,
        });
      }
    }
    if (!migrated) {
      throw new AppError(
        503,
        "SERVICE_UNAVAILABLE",
        "Database not migrated",
        `Migration ${expectedVersion} is not applied`,
      );
    }
    res.json({ status: "ok" });
  });

  return router;
}
