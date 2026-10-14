import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";

export const REQUEST_ID_HEADER = "X-Request-Id";

// Accept a caller's id only if it is short and made of safe characters, so it can't be
// used to inject content into logs or response headers. Otherwise generate a new one.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,200}$/;

function requestIdFor(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers["x-request-id"];
  const id =
    typeof incoming === "string" && SAFE_REQUEST_ID.test(incoming)
      ? incoming
      : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/** Assigns req.id, echoes it as X-Request-Id on every response, and logs one line per request. */
export function requestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: requestIdFor,
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
  });
}
