import { Router } from "express";
import type { Pool } from "pg";
import { createAccount } from "../../services/accounts.js";
import { notFoundHandler } from "../middleware/errors.js";
import { validate } from "../middleware/validate.js";
import { createAccountBody, type CreateAccountBody } from "../schemas/accounts.js";
import { accountView } from "../views.js";

/** Operator routes. Mounted behind requireAdminKey. */
export function adminRouter(pool: Pool): Router {
  const router = Router();

  router.post("/accounts", validate({ body: createAccountBody }), async (req, res) => {
    const created = await createAccount(pool, req.body as CreateAccountBody);
    // The plaintext key is in this response and nowhere else; keep it out of caches.
    res.set("Cache-Control", "no-store");
    res.status(201).json({
      account: accountView(created),
      apiKey: {
        id: created.apiKey.id,
        key: created.apiKey.key,
        prefix: created.apiKey.prefix,
        createdAt: created.apiKey.createdAt.toISOString(),
      },
    });
  });

  // End here, so an unknown /v1/admin/* path is a 404 rather than falling through to
  // the API-key guard on /v1 and answering 401.
  router.use(notFoundHandler);

  return router;
}
