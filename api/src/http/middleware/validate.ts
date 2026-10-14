import type { RequestHandler } from "express";
import type { z } from "zod";
import { AppError, type FieldError } from "../../domain/errors.js";

interface Schemas {
  body?: z.ZodType;
  params?: z.ZodType;
  query?: z.ZodType;
}

function toFieldErrors(error: z.ZodError, location: string): FieldError[] {
  return error.issues.map((issue) => {
    // An unknown key is reported on its parent; name the key itself so the caller sees it.
    const path =
      issue.code === "unrecognized_keys" ? [...issue.path, issue.keys.join(",")] : issue.path;
    return { path: [location, ...path].join("."), message: issue.message };
  });
}

/**
 * Validates and replaces req.body / req.params / req.query with the parsed values (trimmed, typed,
 * defaults applied). All problems are reported together as one 400 VALIDATION_ERROR.
 * Handlers read the result with the matching z.infer type.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const errors: FieldError[] = [];

    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (result.success) req.body = result.data;
      else errors.push(...toFieldErrors(result.error, "body"));
    }
    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (result.success) req.params = result.data as typeof req.params;
      else errors.push(...toFieldErrors(result.error, "params"));
    }
    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      // Express 5 exposes req.query as a getter; shadow it with the parsed value.
      if (result.success) Object.defineProperty(req, "query", { value: result.data });
      else errors.push(...toFieldErrors(result.error, "query"));
    }

    if (errors.length > 0) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid request", undefined, { errors });
    }
    next();
  };
}
