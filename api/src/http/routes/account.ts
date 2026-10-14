import { Router } from "express";
import type { Pool } from "pg";
import { assignAccountPlan, getAccount } from "../../services/accounts.js";
import { authenticatedAccountId } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { assignPlanBody, type AssignPlanBody } from "../schemas/accounts.js";
import { accountView } from "../views.js";

/** The caller's own account. Mounted behind requireApiKey. */
export function accountRouter(pool: Pool): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    res.json(accountView(await getAccount(pool, authenticatedAccountId(req))));
  });

  router.put("/plan", validate({ body: assignPlanBody }), async (req, res) => {
    const { planId } = req.body as AssignPlanBody;
    res.json(accountView(await assignAccountPlan(pool, authenticatedAccountId(req), planId)));
  });

  return router;
}
