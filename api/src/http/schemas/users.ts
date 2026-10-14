import { z } from "zod";

// The caller's own id for its user. It appears in URL paths and log lines, so it is limited
// to characters that need no escaping in either (DESIGN.md §8).
export const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,200}$/;
const externalId = z
  .string()
  .regex(EXTERNAL_ID_PATTERN, "must be 1-200 characters from A-Z a-z 0-9 . _ : @ -");

export const createUserBody = z.strictObject({
  externalId,
  planId: z.uuid().optional(),
});
export type CreateUserBody = z.infer<typeof createUserBody>;

export const assignUserPlanBody = z.strictObject({ planId: z.uuid() });
export type AssignUserPlanBody = z.infer<typeof assignUserPlanBody>;

export const externalIdParams = z.object({ externalId });
export type ExternalIdParams = z.infer<typeof externalIdParams>;

export const listUsersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuery>;
