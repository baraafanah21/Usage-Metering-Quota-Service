import { Router } from "express";
import type { Pool } from "pg";
import { getAccountUsage } from "../../services/usage.js";
import { decodeUserCursor, encodeUserCursor } from "../cursor.js";
import { authenticatedAccountId } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { usageQuery, type UsageQuery } from "../schemas/usage.js";

/** GET /v1/usage: the account's month and a page of its users. Mounted behind requireApiKey. */
export function usageRouter(pool: Pool): Router {
  const router = Router();

  router.get("/", validate({ query: usageQuery }), async (req, res) => {
    const { month, limit, cursor } = req.query as unknown as UsageQuery;
    const after = cursor === undefined ? undefined : decodeUserCursor(cursor);
    const usage = await getAccountUsage(pool, authenticatedAccountId(req), { month, limit, after });
    res.json({
      month: usage.month,
      account: usage.account,
      users: usage.users.map(({ userId, planName, monthlyAllowance, used, remaining }) => ({
        userId,
        planName,
        monthlyAllowance,
        used,
        remaining,
      })),
      nextCursor: usage.next && encodeUserCursor(usage.next),
    });
  });

  return router;
}
