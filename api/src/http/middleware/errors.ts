import type { ErrorRequestHandler, Request, RequestHandler, Response } from "express";
import { isConnectionError } from "../../db/errors.js";
import { AppError, type FieldError } from "../../domain/errors.js";

interface Problem {
  type: "about:blank";
  title: string;
  status: number;
  code: string;
  detail?: string;
  errors?: FieldError[];
  requestId: string;
}

function sendProblem(req: Request, res: Response, error: AppError): void {
  const body: Problem = {
    type: "about:blank",
    title: error.title,
    status: error.status,
    code: error.code,
    ...(error.detail !== undefined && { detail: error.detail }),
    ...(error.errors !== undefined && { errors: error.errors }),
    requestId: String(req.id),
  };
  res.status(error.status).type("application/problem+json").json(body);
}

export const notFoundHandler: RequestHandler = (req) => {
  throw new AppError(404, "NOT_FOUND", "Not found", `No route for ${req.method} ${req.path}`);
};

// body-parser sets `type` on the errors it throws; map the ones a client can cause.
function fromBodyParser(err: unknown): AppError | undefined {
  if (typeof err !== "object" || err === null || !("type" in err)) return undefined;
  switch (err.type) {
    case "entity.parse.failed":
      return new AppError(400, "INVALID_JSON", "Malformed JSON body");
    case "entity.too.large":
      return new AppError(413, "PAYLOAD_TOO_LARGE", "Request body too large");
    case "encoding.unsupported":
    case "charset.unsupported":
      return new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported body encoding");
    default:
      return undefined;
  }
}

// The database is unreachable or dropped the connection (§10). Any open transaction was
// rolled back by Postgres; if the connection broke during COMMIT the outcome is unknown, and
// idempotency by requestId is what makes a retry safe either way.
function fromDatabaseOutage(err: unknown): AppError | undefined {
  if (!isConnectionError(err)) return undefined;
  return new AppError(
    503,
    "SERVICE_UNAVAILABLE",
    "Database unavailable",
    "The database could not be reached; retry the same request later",
    { cause: err },
  );
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const known = err instanceof AppError ? err : (fromBodyParser(err) ?? fromDatabaseOutage(err));
  if (known) {
    if (known.status >= 500) req.log.error({ err }, known.title);
    sendProblem(req, res, known);
    return;
  }

  // Unexpected: log the full error, return nothing about it to the client.
  req.log.error({ err }, "unhandled error");
  sendProblem(req, res, new AppError(500, "INTERNAL_ERROR", "Internal server error"));
};
