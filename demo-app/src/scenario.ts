import { randomUUID } from "node:crypto";
import type { ConsumeResponse, Plan, User } from "./api-types.js";
import { checkQuotaBeforeProcessing } from "./documents.js";
import { type Exchange, MeteringClient, MeteringError } from "./metering.js";
import { createAccount, PREMIUM_PLAN_ID, setUpDemoAccount } from "./provision.js";

// The brief's story (DESIGN.md §14), run on a fresh account every time so the outcome
// doesn't depend on anything done in free play.

interface ConsumeExpectation {
  decision: "accepted" | "rejected";
  scope?: "user" | "account";
  rule?: string;
  accountRemaining?: number;
}

export interface ActionResult {
  kind: "consume" | "config";
  label: string;
  expected: string;
  actual: string;
  pass: boolean;
  request: Exchange["request"];
  response: Exchange["response"];
  /** Consume actions only. */
  decision?: ConsumeResponse["decision"];
  reason?: ConsumeResponse["reason"];
  remaining?: { user: number | null; account: number | null };
}

export interface StepResult {
  number: number;
  title: string;
  explanation: string;
  pass: boolean;
  actions: ActionResult[];
}

export interface ScenarioResult {
  account: { id: string; name: string };
  pass: boolean;
  steps: StepResult[];
}

function describe(e: { decision: string; scope?: string | undefined; rule?: string | undefined }): string {
  return e.decision === "accepted" ? "accepted" : `rejected · ${e.scope} · ${e.rule}`;
}

/** Runs a call; an API error becomes a failed action with its raw exchange, not an exception. */
async function attempt(run: () => Promise<Exchange>): Promise<{ exchange: Exchange; ok: boolean }> {
  try {
    return { exchange: await run(), ok: true };
  } catch (err) {
    if (err instanceof MeteringError) return { exchange: err.exchange, ok: false };
    throw err;
  }
}

async function consumeAction(
  api: MeteringClient,
  user: string,
  units: number,
  expect: ConsumeExpectation,
): Promise<ActionResult> {
  const { exchange, ok } = await attempt(() =>
    checkQuotaBeforeProcessing(api, { user, units, requestId: randomUUID() }),
  );
  let expected = describe(expect);
  if (expect.accountRemaining !== undefined) expected += ` · account remaining ${expect.accountRemaining}`;

  const base = { kind: "consume" as const, label: `${user} processes ${units}`, expected, ...exchange };
  if (!ok) return { ...base, actual: `HTTP ${exchange.response.status}`, pass: false };

  const body = exchange.response.body as ConsumeResponse;
  let actual = describe({ decision: body.decision, scope: body.reason?.scope, rule: body.reason?.rule });
  if (expect.accountRemaining !== undefined) actual += ` · account remaining ${body.account.remaining}`;
  const pass =
    body.decision === expect.decision &&
    body.reason?.scope === expect.scope &&
    body.reason?.rule === expect.rule &&
    (expect.accountRemaining === undefined || body.account.remaining === expect.accountRemaining);

  return {
    ...base,
    actual,
    pass,
    decision: body.decision,
    ...(body.reason && { reason: body.reason }),
    remaining: { user: body.user.remaining, account: body.account.remaining },
  };
}

async function configAction(
  label: string,
  expected: string,
  run: () => Promise<Exchange>,
  check: (body: unknown) => string,
): Promise<ActionResult> {
  const { exchange, ok } = await attempt(run);
  const actual = ok ? check(exchange.response.body) : `HTTP ${exchange.response.status}`;
  return { kind: "config", label, expected, actual, pass: actual === expected, ...exchange };
}

function step(number: number, title: string, explanation: string, actions: ActionResult[]): StepResult {
  return { number, title, explanation, actions, pass: actions.every((a) => a.pass) };
}

export async function runScenario(admin: MeteringClient, baseUrl: string): Promise<ScenarioResult> {
  const name = `Scenario ${new Date().toISOString()}`;
  const created = await createAccount(admin, name);
  const api = MeteringClient.account(baseUrl, created.apiKey);
  const { demoTeamPlanId } = await setUpDemoAccount(api);

  const steps: StepResult[] = [];

  steps.push(
    step(1, "alice processes 10", "A normal request within every limit.", [
      await consumeAction(api, "alice", 10, { decision: "accepted" }),
    ]),
  );

  steps.push(
    step(
      2,
      "alice processes 25",
      "Basic allows at most 20 units per request, so alice's own plan rejects it. Nothing is counted.",
      [await consumeAction(api, "alice", 25, { decision: "rejected", scope: "user", rule: "max_units_per_request" })],
    ),
  );

  steps.push(
    step(
      3,
      "bob processes 45",
      "Premium allows 100 per request and Demo Team 50, so it passes. The shared account has used 55 of 60.",
      [await consumeAction(api, "bob", 45, { decision: "accepted", accountRemaining: 5 })],
    ),
  );

  steps.push(
    step(
      4,
      "carol processes 10",
      "carol has used nothing of her own 1,000, but the shared account has only 5 left: the account rejects it.",
      [await consumeAction(api, "carol", 10, { decision: "rejected", scope: "account", rule: "monthly_allowance" })],
    ),
  );

  steps.push(
    step(
      5,
      "Change configuration only",
      "Two API calls with data, no client code change: raise Demo Team's monthly allowance to 200 and move alice to Premium.",
      [
        await configAction(
          "PATCH Demo Team monthlyAllowance → 200",
          "Demo Team monthlyAllowance 200",
          () => api.call("PATCH", `/v1/plans/${demoTeamPlanId}`, { rules: { monthlyAllowance: 200 } }),
          (body) => `Demo Team monthlyAllowance ${(body as Plan).rules.monthlyAllowance}`,
        ),
        await configAction(
          "PUT alice → Premium",
          "alice on Premium",
          () => api.call("PUT", "/v1/users/alice/plan", { planId: PREMIUM_PLAN_ID }),
          (body) => `alice on ${(body as User).plan.name}`,
        ),
      ],
    ),
  );

  steps.push(
    step(
      6,
      "Same requests again",
      "The same client code sends the requests that were rejected before. The new limits apply to the next request.",
      [
        await consumeAction(api, "carol", 10, { decision: "accepted" }),
        await consumeAction(api, "alice", 25, { decision: "accepted" }),
      ],
    ),
  );

  return { account: { id: created.accountId, name }, pass: steps.every((s) => s.pass), steps };
}
