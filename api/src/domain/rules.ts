// The rules engine (DESIGN.md §5). Pure functions: no I/O, no clock, no database.

export type RuleType = "monthly_allowance" | "max_units_per_request";
export type Scope = "account" | "user";
export type Decision = "accepted" | "rejected";

/** A missing rule means unlimited at that level. A limit of 0 blocks any positive request. */
export interface Rules {
  monthlyAllowance?: number;
  maxUnitsPerRequest?: number;
}

export interface Violation {
  scope: Scope;
  rule: RuleType;
  limit: number;
  /** What was compared against the limit: the units requested, or used + units. */
  actual: number;
  message: string;
}

export interface Evaluation {
  decision: Decision;
  /** The first violation in §5 order, or null when accepted. */
  reason: Violation | null;
  /** Every failing rule, in §5 order. */
  violations: Violation[];
}

export interface LevelState {
  rules: Rules;
  /** Units already accepted at this level this month. */
  used: number;
}

export interface EvaluationInput {
  units: number;
  account: LevelState;
  user: LevelState;
}

export type StatelessInput = {
  units: number;
  account: Pick<LevelState, "rules">;
  user: Pick<LevelState, "rules">;
};

interface RuleContext {
  units: number;
  usedThisMonth: number;
}

interface Evaluator {
  limitOf: (rules: Rules) => number | undefined;
  passes: (limit: number, ctx: RuleContext) => boolean;
  actual: (ctx: RuleContext) => number;
  describe: (label: string, limit: number, ctx: RuleContext) => string;
}

// Adding a rule type = add one entry here (and to the order below).
const evaluators: Record<RuleType, Evaluator> = {
  max_units_per_request: {
    limitOf: (r) => r.maxUnitsPerRequest,
    passes: (limit, c) => c.units <= limit,
    actual: (c) => c.units,
    describe: (label, limit, c) =>
      `${label} max units per request exceeded: ${c.units} requested > ${limit}`,
  },
  monthly_allowance: {
    limitOf: (r) => r.monthlyAllowance,
    passes: (limit, c) => c.usedThisMonth + c.units <= limit,
    actual: (c) => c.usedThisMonth + c.units,
    describe: (label, limit, c) =>
      `${label} monthly allowance exceeded: ${c.usedThisMonth} used + ${c.units} requested > ${limit}`,
  },
};

type Check = { scope: Scope; rule: RuleType };

// §5: stateless rules first (they need no counters, so they can reject before any lock),
// and within each class user before account (the more specific explanation).
const STATELESS_ORDER: Check[] = [
  { scope: "user", rule: "max_units_per_request" },
  { scope: "account", rule: "max_units_per_request" },
];
const MONTHLY_ORDER: Check[] = [
  { scope: "user", rule: "monthly_allowance" },
  { scope: "account", rule: "monthly_allowance" },
];

const LABELS: Record<Scope, string> = { user: "User", account: "Account" };

function check(checks: Check[], units: number, levels: Record<Scope, LevelState>): Violation[] {
  const violations: Violation[] = [];
  for (const { scope, rule } of checks) {
    const evaluator = evaluators[rule];
    const limit = evaluator.limitOf(levels[scope].rules);
    if (limit === undefined) continue; // no rule = unlimited
    const ctx = { units, usedThisMonth: levels[scope].used };
    if (!evaluator.passes(limit, ctx)) {
      violations.push({
        scope,
        rule,
        limit,
        actual: evaluator.actual(ctx),
        message: evaluator.describe(LABELS[scope], limit, ctx),
      });
    }
  }
  return violations;
}

function result(violations: Violation[]): Evaluation {
  return {
    decision: violations.length === 0 ? "accepted" : "rejected",
    reason: violations[0] ?? null,
    violations,
  };
}

/** Per-request rules only. Needs no counters, so consume can run it before taking any lock. */
export function evaluateStateless({ units, account, user }: StatelessInput): Evaluation {
  const levels = {
    account: { rules: account.rules, used: 0 },
    user: { rules: user.rules, used: 0 },
  };
  return result(check(STATELESS_ORDER, units, levels));
}

/** Every rule of both plans, in §5 order. Both levels must pass for the request to be accepted. */
export function evaluate({ units, account, user }: EvaluationInput): Evaluation {
  const levels = { account, user };
  return result([
    ...check(STATELESS_ORDER, units, levels),
    ...check(MONTHLY_ORDER, units, levels),
  ]);
}

/** null when unlimited; otherwise never negative, even when the limit was lowered below usage. */
export function remaining(limit: number | undefined, used: number): number | null {
  return limit === undefined ? null : Math.max(0, limit - used);
}

/** Converts stored rules (null = no rule) to engine rules (missing = no rule). */
export function toRules(stored: {
  monthlyAllowance: number | null;
  maxUnitsPerRequest: number | null;
}): Rules {
  return {
    ...(stored.monthlyAllowance !== null && { monthlyAllowance: stored.monthlyAllowance }),
    ...(stored.maxUnitsPerRequest !== null && { maxUnitsPerRequest: stored.maxUnitsPerRequest }),
  };
}
