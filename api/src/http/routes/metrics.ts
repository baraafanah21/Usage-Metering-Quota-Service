import { Router } from "express";
import type { Pool } from "pg";
import { registry, samplePool } from "../../metrics.js";

/** GET /metrics in Prometheus text format. Unauthenticated, like /health: no tenant data. */
export function metricsRouter(pool: Pool): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    samplePool(pool);
    res.type(registry.contentType).send(await registry.metrics());
  });

  return router;
}
