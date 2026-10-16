import express, { type Express, Router } from "express";
import type { Pool } from "pg";
import type { Logger } from "pino";
import { requireAdminKey, requireApiKey } from "./http/middleware/auth.js";
import { errorHandler, notFoundHandler } from "./http/middleware/errors.js";
import { requestLogger } from "./http/middleware/requestLogger.js";
import { accountRouter } from "./http/routes/account.js";
import { adminRouter } from "./http/routes/admin.js";
import { consumeRouter } from "./http/routes/consume.js";
import { healthRouter } from "./http/routes/health.js";
import { plansRouter } from "./http/routes/plans.js";
import { requestsRouter } from "./http/routes/requests.js";
import { usageRouter } from "./http/routes/usage.js";
import { usersRouter } from "./http/routes/users.js";

export interface AppDeps {
  pool: Pool;
  logger: Logger;
  adminApiKey: string;
}

/** Builds the Express app without listening, so tests can drive it in-process with supertest. */
export function createApp({ pool, logger, adminApiKey }: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");

  app.use(requestLogger(logger));
  app.use(express.json({ limit: "100kb" }));

  app.use("/health", healthRouter(pool));

  const v1 = Router();
  // Admin first: it has its own guard and must not require an account API key.
  v1.use("/admin", requireAdminKey(adminApiKey), adminRouter(pool));
  // Everything else under /v1 belongs to an account.
  v1.use(requireApiKey(pool));
  v1.use("/account", accountRouter(pool));
  v1.use("/plans", plansRouter(pool));
  v1.use("/users", usersRouter(pool));
  v1.use("/consume", consumeRouter(pool));
  v1.use("/usage", usageRouter(pool));
  v1.use("/requests", requestsRouter(pool));
  app.use("/v1", v1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
