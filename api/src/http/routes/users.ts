import { Router } from "express";
import type { Pool } from "pg";
import {
  assignUserPlan,
  createUser,
  getEffectiveLimits,
  getUser,
  listUsers,
} from "../../services/users.js";
import { decodeUserCursor, encodeUserCursor } from "../cursor.js";
import { authenticatedAccountId } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  assignUserPlanBody,
  type AssignUserPlanBody,
  createUserBody,
  type CreateUserBody,
  externalIdParams,
  type ExternalIdParams,
  listUsersQuery,
  type ListUsersQuery,
} from "../schemas/users.js";
import { userListItemView, userView } from "../views.js";

/** The caller's end users, addressed by their externalId. Mounted behind requireApiKey. */
export function usersRouter(pool: Pool): Router {
  const router = Router();

  router.post("/", validate({ body: createUserBody }), async (req, res) => {
    const body = req.body as CreateUserBody;
    const created = await createUser(pool, authenticatedAccountId(req), body);
    res
      .status(201)
      .location(`/v1/users/${encodeURIComponent(body.externalId)}`)
      .json(userView(created));
  });

  router.get("/", validate({ query: listUsersQuery }), async (req, res) => {
    const { limit, cursor } = req.query as unknown as ListUsersQuery;
    const after = cursor === undefined ? undefined : decodeUserCursor(cursor);
    const page = await listUsers(pool, authenticatedAccountId(req), { limit, after });
    res.json({
      users: page.users.map(userListItemView),
      nextCursor: page.next && encodeUserCursor(page.next),
    });
  });

  router.get("/:externalId", validate({ params: externalIdParams }), async (req, res) => {
    const { externalId } = req.params as ExternalIdParams;
    res.json(userView(await getUser(pool, authenticatedAccountId(req), externalId)));
  });

  router.put(
    "/:externalId/plan",
    validate({ params: externalIdParams, body: assignUserPlanBody }),
    async (req, res) => {
      const { externalId } = req.params as ExternalIdParams;
      const { planId } = req.body as AssignUserPlanBody;
      res.json(userView(await assignUserPlan(pool, authenticatedAccountId(req), externalId, planId)));
    },
  );

  router.get("/:externalId/limits", validate({ params: externalIdParams }), async (req, res) => {
    const { externalId } = req.params as ExternalIdParams;
    res.json(await getEffectiveLimits(pool, authenticatedAccountId(req), externalId));
  });

  return router;
}
