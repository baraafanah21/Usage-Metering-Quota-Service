import { z } from "zod";
import { MONTH_PATTERN } from "../../domain/month.js";
import { EXTERNAL_ID_PATTERN } from "./users.js";

// Omitted → the current UTC month by the database clock (resolved in SQL, never the app clock).
const month = z.string().regex(MONTH_PATTERN, "must be a month as YYYY-MM").optional();
const limit = z.coerce.number().int().min(1).max(100).default(20);
const cursor = z.string().min(1).max(512).optional();

export const usageQuery = z.object({ month, limit, cursor });
export type UsageQuery = z.infer<typeof usageQuery>;

export const userUsageQuery = z.object({ month });
export type UserUsageQuery = z.infer<typeof userUsageQuery>;

export const requestsQuery = z.object({
  userId: z.string().regex(EXTERNAL_ID_PATTERN, "must be a registered user's externalId").optional(),
  month,
  decision: z.enum(["accepted", "rejected"]).optional(),
  include: z.enum(["evaluation"]).optional(),
  limit,
  cursor,
});
export type RequestsQuery = z.infer<typeof requestsQuery>;
