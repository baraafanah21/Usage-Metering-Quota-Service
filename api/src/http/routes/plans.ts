import { Router } from "express";
import type { Pool } from "pg";
import { createPlan, getPlan, listPlans, updatePlan } from "../../services/plans.js";
import { authenticatedAccountId } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  createPlanBody,
  type CreatePlanBody,
  listPlansQuery,
  type ListPlansQuery,
  patchPlanBody,
  type PatchPlanBody,
  planIdParams,
  type PlanIdParams,
} from "../schemas/plans.js";
import { planDetailView, planView } from "../views.js";

/**
 * Predefined plans (read-only, visible to all) and the caller's own custom plans.
 * Mounted behind requireApiKey. There is deliberately no DELETE: plans are never deleted,
 * so every ledger row keeps pointing at a real plan (DESIGN.md §16).
 */
export function plansRouter(pool: Pool): Router {
  const router = Router();

  router.get("/", validate({ query: listPlansQuery }), async (req, res) => {
    const { scope } = req.query as ListPlansQuery;
    const plans = await listPlans(pool, authenticatedAccountId(req), scope);
    res.json({ plans: plans.map(planView) });
  });

  router.post("/", validate({ body: createPlanBody }), async (req, res) => {
    const plan = await createPlan(pool, authenticatedAccountId(req), req.body as CreatePlanBody);
    res.status(201).location(`/v1/plans/${plan.id}`).json(planView(plan));
  });

  router.get("/:planId", validate({ params: planIdParams }), async (req, res) => {
    const { planId } = req.params as PlanIdParams;
    const { plan, assignments } = await getPlan(pool, authenticatedAccountId(req), planId);
    res.json(planDetailView(plan, assignments));
  });

  router.patch(
    "/:planId",
    validate({ params: planIdParams, body: patchPlanBody }),
    async (req, res) => {
      const { planId } = req.params as PlanIdParams;
      const plan = await updatePlan(pool, authenticatedAccountId(req), planId, req.body as PatchPlanBody);
      res.json(planView(plan));
    },
  );

  return router;
}
