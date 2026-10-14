import { pino, type Logger } from "pino";
import type { Config } from "./config.js";

export function createLogger(level: Config["LOG_LEVEL"]): Logger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers["x-api-key"]',
        'req.headers["x-admin-key"]',
        "req.headers.authorization",
        "req.headers.cookie",
      ],
      censor: "[REDACTED]",
    },
  });
}
