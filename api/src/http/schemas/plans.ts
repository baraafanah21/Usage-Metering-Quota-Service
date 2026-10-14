import { z } from "zod";

const scope = z.enum(["account", "user"]);
const name = z.string().trim().min(1).max(100);
// z.int() is limited to safe integers, so limits round-trip through JS numbers exactly.
// 0 is valid and blocks consumption at that level (§16.4).
const limit = z.int().min(0);

export const planIdParams = z.object({ planId: z.uuid() });
export type PlanIdParams = z.infer<typeof planIdParams>;

// Not strict: unrelated query parameters (cache busters etc.) are ignored, not rejected.
export const listPlansQuery = z.object({ scope: scope.optional() });
export type ListPlansQuery = z.infer<typeof listPlansQuery>;

export const createPlanBody = z.strictObject({
  name,
  scope,
  // Required (possibly {}), so an unlimited plan is always a deliberate choice.
  rules: z.strictObject({
    monthlyAllowance: limit.optional(),
    maxUnitsPerRequest: limit.optional(),
  }),
});
export type CreatePlanBody = z.infer<typeof createPlanBody>;

export const patchPlanBody = z
  .strictObject({
    name: name.optional(),
    // Named explicitly so the error says why, instead of a generic "unrecognized key".
    scope: z.never({ error: "scope cannot be changed" }).optional(),
    rules: z
      .strictObject({
        // number = set, null = remove the rule (unlimited), missing = leave unchanged
        monthlyAllowance: limit.nullable().optional(),
        maxUnitsPerRequest: limit.nullable().optional(),
      })
      .optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.rules?.monthlyAllowance !== undefined ||
      body.rules?.maxUnitsPerRequest !== undefined,
    { error: "Nothing to update: send name and/or a rule in rules" },
  );
export type PatchPlanBody = z.infer<typeof patchPlanBody>;
