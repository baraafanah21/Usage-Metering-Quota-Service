import { createServer } from "node:http";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { createLogger } from "./logger.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.LOG_LEVEL);
  const pool = createPool({ connectionString: config.DATABASE_URL, max: config.DB_POOL_MAX }, logger);
  const server = createServer(createApp({ pool, logger }));

  // Bound how long one request can hold a socket (DESIGN.md §10, pool exhaustion).
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  server.on("error", (err) => {
    logger.fatal({ err }, "http server error");
    process.exit(1);
  });

  server.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "listening");
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    const forceExit = setTimeout(() => {
      logger.error("graceful shutdown timed out, forcing exit");
      server.closeAllConnections();
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    // close() stops accepting connections and calls back once in-flight requests finish.
    // Idle keep-alive sockets would otherwise hold it open until they time out.
    server.close(async (err) => {
      if (err) logger.error({ err }, "error closing http server");
      try {
        await pool.end();
      } catch (poolErr) {
        logger.error({ err: poolErr }, "error closing database pool");
      }
      logger.info("shutdown complete");
      process.exit(err ? 1 : 0);
    });
    server.closeIdleConnections();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
