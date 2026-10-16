import type { RequestHandler } from "express";
import { httpRequestDuration, routeLabel } from "../../metrics.js";

/** Observes every request's duration once the response is sent (§12). */
export function httpMetrics(): RequestHandler {
  return (req, res, next) => {
    const end = httpRequestDuration.startTimer();
    res.on("finish", () => {
      end({ route: routeLabel(req), method: req.method, status: String(res.statusCode) });
    });
    next();
  };
}
