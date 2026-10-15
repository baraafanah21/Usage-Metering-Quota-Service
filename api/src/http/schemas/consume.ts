import { z } from "zod";
import { EXTERNAL_ID_PATTERN } from "./users.js";

/** Input-sanity bound, separate from any plan rule (§16.5). */
export const MAX_UNITS_PER_CALL = 1_000_000_000;

export const consumeBody = z.strictObject({
  userId: z.string().regex(EXTERNAL_ID_PATTERN, "must be a registered user's externalId"),
  // z.int() rejects floats and non-safe integers; strings like "10" are rejected, not coerced.
  units: z.int().min(1).max(MAX_UNITS_PER_CALL),
  // Any text the caller likes (it is the caller's key), but Postgres text can't hold NUL.
  requestId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\u0000]*$/, "must not contain NUL characters"),
});
export type ConsumeBody = z.infer<typeof consumeBody>;
