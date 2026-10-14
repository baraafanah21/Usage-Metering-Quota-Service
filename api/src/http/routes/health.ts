import { Router } from "express";
import type { Pool } from "pg";
import { AppError } from "../../domain/errors.js";

export function healthRouter(pool: Pool): Router {
  const router = Router();

  // Liveness: the process is up and the event loop answers. Never touches the database,
  // so a database outage doesn't get the container restarted.
  router.get("/live", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Readiness: we can serve traffic, i.e. the database answers.
  // TODO(phase 2): also require migrations to be applied (DESIGN.md §12).
  router.get("/ready", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
    } catch (err) {
      // The error middleware logs it (with the cause) as a 5xx.
      throw new AppError(503, "SERVICE_UNAVAILABLE", "Database unavailable", undefined, {
        cause: err,
      });
    }
    res.json({ status: "ok" });
  });

  return router;
}
