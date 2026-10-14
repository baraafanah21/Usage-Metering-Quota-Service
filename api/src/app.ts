import express, { type Express } from "express";
import type { Pool } from "pg";
import type { Logger } from "pino";
import { errorHandler, notFoundHandler } from "./http/middleware/errors.js";
import { requestLogger } from "./http/middleware/requestLogger.js";
import { healthRouter } from "./http/routes/health.js";

export interface AppDeps {
  pool: Pool;
  logger: Logger;
}

/** Builds the Express app without listening, so tests can drive it in-process with supertest. */
export function createApp({ pool, logger }: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");

  app.use(requestLogger(logger));
  app.use(express.json({ limit: "100kb" }));

  app.use("/health", healthRouter(pool));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
