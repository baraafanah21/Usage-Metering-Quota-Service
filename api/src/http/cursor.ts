import { z } from "zod";
import { AppError } from "../domain/errors.js";
import type { UserCursor } from "../repositories/users.js";

// Opaque to callers: base64url of a JSON [createdAt, id] tuple. The format is ours to
// change; clients must only pass back what they received.
const userCursorTuple = z.tuple([z.iso.datetime(), z.uuid()]);
// A ledger id (positive bigint) as a string: JSON numbers lose precision past 2^53.
const requestCursorTuple = z.tuple([z.string().regex(/^[1-9][0-9]{0,18}$/)]);

const encode = (tuple: unknown[]) => Buffer.from(JSON.stringify(tuple)).toString("base64url");

/** Throws 400 INVALID_CURSOR for anything we did not produce. */
function decode<T extends z.ZodType>(raw: string, schema: T): z.infer<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    parsed = undefined;
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new AppError(400, "INVALID_CURSOR", "Invalid cursor", "Pass back a nextCursor value exactly as returned");
  }
  return result.data;
}

export function encodeUserCursor(cursor: UserCursor): string {
  return encode([cursor.createdAt, cursor.id]);
}

export function decodeUserCursor(raw: string): UserCursor {
  const [createdAt, id] = decode(raw, userCursorTuple);
  return { createdAt, id };
}

/** Position in GET /v1/requests: the last ledger id returned. The next page has id < it. */
export function encodeRequestCursor(id: string): string {
  return encode([id]);
}

export function decodeRequestCursor(raw: string): string {
  return decode(raw, requestCursorTuple)[0];
}
