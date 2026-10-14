import { z } from "zod";

// strictObject: unknown fields are a 400, never silently ignored or passed through.
export const createAccountBody = z.strictObject({
  name: z.string().trim().min(1).max(200),
  planId: z.uuid().optional(),
});
export type CreateAccountBody = z.infer<typeof createAccountBody>;

export const assignPlanBody = z.strictObject({
  planId: z.uuid(),
});
export type AssignPlanBody = z.infer<typeof assignPlanBody>;
