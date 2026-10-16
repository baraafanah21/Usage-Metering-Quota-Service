import { Router } from "express";
import type { Pool } from "pg";
import { listHistory } from "../../services/usage.js";
import { decodeRequestCursor, encodeRequestCursor } from "../cursor.js";
import { authenticatedAccountId } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { requestsQuery, type RequestsQuery } from "../schemas/usage.js";
import { requestView } from "../views.js";

/** GET /v1/requests: the account's decision history, newest first. Mounted behind requireApiKey. */
export function requestsRouter(pool: Pool): Router {
  const router = Router();

  router.get("/", validate({ query: requestsQuery }), async (req, res) => {
    const { userId, month, decision, include, limit, cursor } = req.query as unknown as RequestsQuery;
    const before = cursor === undefined ? undefined : decodeRequestCursor(cursor);
    const page = await listHistory(pool, authenticatedAccountId(req), {
      userId,
      month,
      decision,
      limit,
      before,
      withEvaluation: include === "evaluation",
    });
    res.json({
      requests: page.requests.map(requestView),
      nextCursor: page.next && encodeRequestCursor(page.next),
    });
  });

  return router;
}
