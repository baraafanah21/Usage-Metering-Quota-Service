import { describe, expect, it } from "vitest";
import {
  evaluate,
  evaluateStateless,
  type EvaluationInput,
  remaining,
  toRules,
} from "../../src/domain/rules.js";

// The predefined plans from §9.
const STARTER = { monthlyAllowance: 10_000, maxUnitsPerRequest: 100 };
const BASIC = { monthlyAllowance: 1_000, maxUnitsPerRequest: 20 };

function input(
  units: number,
  account: Partial<EvaluationInput["account"]> = {},
  user: Partial<EvaluationInput["user"]> = {},
): EvaluationInput {
  return {
    units,
    account: { rules: STARTER, used: 0, ...account },
    user: { rules: BASIC, used: 0, ...user },
  };
}

describe("evaluate: the brief's examples (§5)", () => {
  it("25 units on Basic → rejected by the user's max_units_per_request", () => {
    const result = evaluate(input(25));
    expect(result.decision).toBe("rejected");
    expect(result.reason).toEqual({
      scope: "user",
      rule: "max_units_per_request",
      limit: 20,
      actual: 25,
      message: "User max units per request exceeded: 25 requested > 20",
    });
    expect(result.violations).toHaveLength(1);
  });

  it("10 units with room at both levels → accepted", () => {
    expect(evaluate(input(10, { used: 4_200 }, { used: 300 }))).toEqual({
      decision: "accepted",
      reason: null,
      violations: [],
    });
  });

  it("account has 5 left, user has plenty → rejected by the account's monthly_allowance", () => {
    const result = evaluate(input(10, { used: 9_995 }, { used: 0 }));
    expect(result.decision).toBe("rejected");
    expect(result.reason).toEqual({
      scope: "account",
      rule: "monthly_allowance",
      limit: 10_000,
      actual: 10_005,
      message: "Account monthly allowance exceeded: 9995 used + 10 requested > 10000",
    });
  });
});

describe("evaluate: order and completeness", () => {
  it("returns every violation in §5 order; reason is the first", () => {
    // 150 units: over both per-request limits (20, 100) and, with this usage, both monthly ones.
    const result = evaluate(input(150, { used: 9_900 }, { used: 900 }));
    expect(result.violations.map((v) => `${v.scope}.${v.rule}`)).toEqual([
      "user.max_units_per_request",
      "account.max_units_per_request",
      "user.monthly_allowance",
      "account.monthly_allowance",
    ]);
    expect(result.reason).toBe(result.violations[0]);
  });

  it("puts a user rule before the account rule of the same class", () => {
    const result = evaluate(input(10, { used: 9_995 }, { used: 995 }));
    expect(result.violations.map((v) => v.scope)).toEqual(["user", "account"]);
    expect(result.reason?.rule).toBe("monthly_allowance");
  });

  it("puts any per-request violation before any monthly violation", () => {
    // Account per-request fails (150 > 100) and the user monthly fails; per-request wins.
    const result = evaluate(
      input(150, { rules: STARTER }, { rules: { monthlyAllowance: 100 }, used: 0 }),
    );
    expect(result.violations.map((v) => `${v.scope}.${v.rule}`)).toEqual([
      "account.max_units_per_request",
      "user.monthly_allowance",
    ]);
  });
});

describe("evaluate: boundaries", () => {
  it("used + units exactly at the monthly limit → accepted; one more → rejected", () => {
    expect(evaluate(input(10, {}, { used: 990 })).decision).toBe("accepted");
    expect(evaluate(input(11, {}, { used: 990 })).reason?.rule).toBe("monthly_allowance");
  });

  it("units exactly at the per-request limit → accepted; one more → rejected", () => {
    expect(evaluate(input(20)).decision).toBe("accepted");
    expect(evaluate(input(21)).reason?.rule).toBe("max_units_per_request");
  });

  it("a missing rule is unlimited at that level", () => {
    const unlimited = { rules: {}, used: 1_000_000_000 };
    expect(evaluate(input(1_000_000, unlimited, unlimited)).decision).toBe("accepted");
    // Only the user level has rules: the account level can never be the reason.
    const result = evaluate(input(1_000, unlimited, {}));
    expect(result.violations.every((v) => v.scope === "user")).toBe(true);
  });

  it("a limit of 0 rejects a 1-unit request", () => {
    const zero = { rules: { monthlyAllowance: 0 } };
    expect(evaluate(input(1, {}, zero)).reason).toMatchObject({
      scope: "user",
      rule: "monthly_allowance",
      limit: 0,
      actual: 1,
    });
    expect(evaluate(input(1, {}, { rules: { maxUnitsPerRequest: 0 } })).reason?.rule).toBe(
      "max_units_per_request",
    );
  });
});

describe("evaluateStateless", () => {
  it("checks only per-request rules, so it never needs counters", () => {
    expect(evaluateStateless(input(25)).reason).toMatchObject({ scope: "user", rule: "max_units_per_request" });
    expect(evaluateStateless(input(150)).violations.map((v) => v.scope)).toEqual(["user", "account"]);
  });

  it("accepts a request that only a monthly rule would reject", () => {
    expect(evaluateStateless(input(10, { used: 9_995 })).decision).toBe("accepted");
  });

  it("agrees with evaluate on the per-request part", () => {
    const full = evaluate(input(150, { used: 9_995 }, { used: 995 }));
    const stateless = evaluateStateless(input(150));
    expect(full.violations.slice(0, 2)).toEqual(stateless.violations);
  });
});

describe("remaining", () => {
  it("is limit − used", () => {
    expect(remaining(1_000, 310)).toBe(690);
    expect(remaining(1_000, 1_000)).toBe(0);
  });

  it("clamps to 0 when the limit was lowered below usage", () => {
    expect(remaining(100, 450)).toBe(0);
  });

  it("is null when unlimited", () => {
    expect(remaining(undefined, 12_345)).toBeNull();
  });
});

describe("toRules", () => {
  it("drops null (no rule) and keeps 0 (a real limit)", () => {
    expect(toRules({ monthlyAllowance: null, maxUnitsPerRequest: 0 })).toEqual({ maxUnitsPerRequest: 0 });
    expect(toRules({ monthlyAllowance: null, maxUnitsPerRequest: null })).toEqual({});
  });
});
