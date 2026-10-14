import { z } from "zod";
import { AppError } from "../domain/errors.js";
import type { UserCursor } from "../repositories/users.js";

// Opaque to callers: base64url of a JSON [createdAt, id] tuple. The format is ours to
// change; clients must only pass back what they received.
const userCursorTuple = z.tuple([z.iso.datetime(), z.uuid()]);

export function encodeUserCursor(cursor: UserCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString("base64url");
}

/** Throws 400 INVALID_CURSOR for anything we did not produce. */
export function decodeUserCursor(raw: string): UserCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    parsed = undefined;
  }
  const result = userCursorTuple.safeParse(parsed);
  if (!result.success) {
    throw new AppError(400, "INVALID_CURSOR", "Invalid cursor", "Pass back a nextCursor value exactly as returned");
  }
  const [createdAt, id] = result.data;
  return { createdAt, id };
}
