import { Router } from "express";
import type { Pool } from "pg";
import { consume } from "../../services/consume.js";
import { authenticatedAccountId } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { consumeBody, type ConsumeBody } from "../schemas/consume.js";

/** POST /v1/consume. Mounted behind requireApiKey. */
export function consumeRouter(pool: Pool): Router {
  const router = Router();

  router.post("/", validate({ body: consumeBody }), async (req, res) => {
    const response = await consume(pool, authenticatedAccountId(req), req.body as ConsumeBody);

    // Picked up by the request logger for this request's log line (§12).
    res.locals.decisionLog = {
      decision: response.decision,
      rejectScope: response.reason?.scope ?? null,
      rejectRule: response.reason?.rule ?? null,
      replayed: response.replayed,
    };
    if (response.replayed) res.set("Idempotent-Replayed", "true");
    // A rejection is a business outcome, not an HTTP error (§6.1): 200 either way.
    res.json(response);
  });

  return router;
}
