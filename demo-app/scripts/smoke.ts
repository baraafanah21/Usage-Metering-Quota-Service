// Smoke test against a running stack: `npm run smoke` (DEMO_URL defaults to http://localhost:8080).
//
// 1. Runs the guided scenario and checks every step's outcome from the raw API responses,
//    independently of the demo server's own pass/fail marks.
// 2. Processes and retries one document on DocuCorp and expects `replayed: true`. It asks for
//    more units than any per-request limit allows, so it is rejected and uses up no quota.
// 3. Checks that no response the page receives contains an `mk_` API key.

const DEMO_URL = process.env.DEMO_URL ?? "http://localhost:8080";
const KEY_PATTERN = /mk_[A-Za-z0-9]/;

interface Exchange {
  request: { method: string; path: string; body?: Record<string, unknown> };
  response: { status: number; body: Record<string, any> };
}
interface Step {
  number: number;
  pass: boolean;
  actions: Array<Exchange & { label: string }>;
}

let failures = 0;
function check(ok: boolean, what: string, detail = ""): void {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${detail && !ok ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

const bodiesSeen: Array<{ path: string; text: string }> = [];

async function get(path: string): Promise<{ status: number; text: string }> {
  const res = await fetch(new URL(path, DEMO_URL));
  const text = await res.text();
  bodiesSeen.push({ path, text });
  return { status: res.status, text };
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(new URL(path, DEMO_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  bodiesSeen.push({ path, text });
  return { status: res.status, body: JSON.parse(text) as T };
}

async function waitForDemo(): Promise<void> {
  const giveUpAt = Date.now() + 120_000;
  for (;;) {
    try {
      const res = await fetch(new URL("/health/ready", DEMO_URL));
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > giveUpAt) throw new Error(`demo not ready at ${DEMO_URL} after 120s`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

function checkConsume(step: Step, index: number, user: string, units: number, expected: Record<string, unknown>) {
  const a = step.actions[index];
  const label = `step ${step.number}: ${user} processes ${units}`;
  if (!a) return check(false, label, "action missing");
  const req = a.request.body ?? {};
  const body = a.response.body;
  const actual: Record<string, unknown> = {
    status: a.response.status,
    userId: req.userId,
    units: req.units,
    decision: body.decision,
    scope: body.reason?.scope,
    rule: body.reason?.rule,
    accountRemaining: body.account?.remaining,
  };
  const want: Record<string, unknown> = { status: 200, userId: user, units, scope: undefined, rule: undefined, ...expected };
  // accountRemaining is only checked where the step names it.
  const ok = Object.keys(want).every((k) => actual[k] === want[k]);
  check(ok, `${label} → ${describe(want)}`, `got ${JSON.stringify(actual)}`);
}

function describe(e: Record<string, unknown>): string {
  let s = e.decision === "accepted" ? "accepted" : `rejected (${e.scope}, ${e.rule})`;
  if (e.accountRemaining !== undefined) s += `, account remaining ${e.accountRemaining}`;
  return s;
}

async function main(): Promise<void> {
  console.log(`smoke test against ${DEMO_URL}`);
  await waitForDemo();

  // ---- guided scenario ----
  const { status, body: result } = await post<{ pass: boolean; steps: Step[] }>("/api/scenario", {});
  check(status === 200, "POST /api/scenario → 200", `got ${status}`);
  const steps = new Map(result.steps.map((s) => [s.number, s]));
  check(steps.size === 6, "scenario has six steps", `got ${steps.size}`);
  const s = (n: number) => steps.get(n) ?? { number: n, pass: false, actions: [] };

  checkConsume(s(1), 0, "alice", 10, { decision: "accepted" });
  checkConsume(s(2), 0, "alice", 25, { decision: "rejected", scope: "user", rule: "max_units_per_request" });
  checkConsume(s(3), 0, "bob", 45, { decision: "accepted", accountRemaining: 5 });
  checkConsume(s(4), 0, "carol", 10, { decision: "rejected", scope: "account", rule: "monthly_allowance" });

  const [patch, put] = s(5).actions;
  check(
    patch?.request.method === "PATCH" && patch.response.status === 200 && patch.response.body.rules?.monthlyAllowance === 200,
    "step 5: PATCH Demo Team monthlyAllowance → 200",
    JSON.stringify(patch?.response),
  );
  check(
    put?.request.method === "PUT" && put.response.status === 200 && put.response.body.plan?.name === "Premium",
    "step 5: PUT alice → Premium",
    JSON.stringify(put?.response),
  );

  checkConsume(s(6), 0, "carol", 10, { decision: "accepted" });
  checkConsume(s(6), 1, "alice", 25, { decision: "accepted" });
  check(result.pass && result.steps.every((x) => x.pass), "demo server marks every step as passed");

  // ---- free play: process, then retry the same requestId ----
  const first = await post<Exchange>("/api/process", { user: "alice", units: 1_000 });
  check(first.status === 200 && first.body.response.body.replayed === false, "POST /api/process → a fresh decision", JSON.stringify(first.body));
  const requestId = first.body.request.body?.requestId;
  const again = await post<Exchange>("/api/retry", { user: "alice", units: 1_000, requestId });
  check(
    again.status === 200 &&
      again.body.response.body.replayed === true &&
      again.body.response.body.decision === first.body.response.body.decision,
    "POST /api/retry with the same requestId → replayed: true, same decision",
    JSON.stringify(again.body.response),
  );

  const unknown = await post<{ error?: { code?: string; source?: string } }>("/api/process", { user: "nobody", units: 1 });
  check(
    unknown.status === 404 && unknown.body.error?.code === "USER_NOT_FOUND" && unknown.body.error.source === "metering-api",
    "an API error reaches the page as 404 USER_NOT_FOUND",
    JSON.stringify(unknown),
  );

  // ---- no API key in anything the browser receives ----
  for (const path of ["/", "/app.js", "/style.css", "/api/state"]) {
    const res = await get(path);
    check(res.status === 200, `GET ${path} → 200`, `got ${res.status}`);
  }
  const leaks = bodiesSeen.filter((b) => KEY_PATTERN.test(b.text)).map((b) => b.path);
  check(leaks.length === 0, `no "mk_" key in any of ${bodiesSeen.length} responses`, `found in ${leaks.join(", ")}`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
