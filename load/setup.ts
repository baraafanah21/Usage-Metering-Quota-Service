// Creates the data one load scenario needs (DESIGN.md §11.2) through the public API, and
// writes what k6 needs (API keys, user ids, plan ids) and what the checks expect to a JSON
// file. Every run creates fresh accounts, so runs never share counters.
//
//   node setup.ts <scenario> <out.json>        (run by load/run.sh in the load-setup container)
//
// Plain Node 22 (type stripping), no dependencies. Keys are only ever in the output file,
// which is gitignored and mode 600.

import { chmodSync, renameSync, writeFileSync } from "node:fs";

const API_URL = process.env.API_URL ?? "http://api:3000";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
// Setup requests in flight at once; enough to create spread's 200 accounts in a few seconds.
const PARALLEL = 16;

interface Rules {
  monthlyAllowance?: number;
  maxUnitsPerRequest?: number;
}

interface LoadAccount {
  accountId: string;
  apiKey: string;
  userPlanId: string;
  users: string[];
}

interface SetupOutput {
  scenario: string;
  accounts: LoadAccount[];
  /** retry-storm: the fixed requests, sent over and over. */
  requests?: { requestId: string; userId: string; units: number }[];
  /** Checked by verify.sql against accounts[0] after the run. */
  expect?: { acceptedUnits: number; ledgerRows: number };
}

async function call<T>(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** A fresh account on its own account plan, with `userCount` users on one custom user plan. */
async function meteredAccount(name: string, opts: { account: Rules; user: Rules; userCount: number }): Promise<LoadAccount> {
  const created = await call<{ account: { id: string }; apiKey: { key: string } }>(
    "POST",
    "/v1/admin/accounts",
    { "x-admin-key": ADMIN_API_KEY! },
    { name },
  );
  const key = { "x-api-key": created.apiKey.key };
  const accountPlan = await call<{ id: string }>("POST", "/v1/plans", key, {
    name: `${name} account plan`,
    scope: "account",
    rules: opts.account,
  });
  const userPlan = await call<{ id: string }>("POST", "/v1/plans", key, {
    name: `${name} user plan`,
    scope: "user",
    rules: opts.user,
  });
  await call("PUT", "/v1/account/plan", key, { planId: accountPlan.id });

  const users = Array.from({ length: opts.userCount }, (_, i) => `user-${i}`);
  await inParallel(users, (externalId) => call("POST", "/v1/users", key, { externalId, planId: userPlan.id }));
  return { accountId: created.account.id, apiKey: created.apiKey.key, userPlanId: userPlan.id, users };
}

async function inParallel<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  return results;
}

// The data each scenario needs. Limits are unlimited ({}) unless the scenario is about a limit.
const SCENARIOS: Record<string, (run: string) => Promise<SetupOutput>> = {
  // No contention: 200 independent accounts × 5 users.
  spread: async (run) => ({
    scenario: "spread",
    accounts: await inParallel(
      Array.from({ length: 200 }, (_, i) => i),
      (i) => meteredAccount(`load ${run} spread ${i}`, { account: {}, user: {}, userCount: 5 }),
    ),
  }),

  // One account row shared by 500 users.
  "hot-account": async (run) => ({
    scenario: "hot-account",
    accounts: [await meteredAccount(`load ${run} hot-account`, { account: {}, user: {}, userCount: 500 })],
  }),

  // One user: both counter rows hot.
  "hot-user": async (run) => ({
    scenario: "hot-user",
    accounts: [await meteredAccount(`load ${run} hot-user`, { account: {}, user: {}, userCount: 1 })],
  }),

  // 2,000 requests × 10 units against an allowance of 10,000: exactly 1,000 may be accepted.
  exhaust: async (run) => ({
    scenario: "exhaust",
    accounts: [
      await meteredAccount(`load ${run} exhaust`, { account: { monthlyAllowance: 10_000 }, user: {}, userCount: 50 }),
    ],
    expect: { acceptedUnits: 10_000, ledgerRows: 2_000 },
  }),

  // 100 fixed requests, each sent many times concurrently: one ledger row and one increment each.
  "retry-storm": async (run) => {
    const account = await meteredAccount(`load ${run} retry-storm`, { account: {}, user: {}, userCount: 10 });
    const requests = Array.from({ length: 100 }, (_, i) => ({
      requestId: `retry-${i}`,
      userId: account.users[i % account.users.length]!,
      units: (i % 5) + 1,
    }));
    return {
      scenario: "retry-storm",
      accounts: [account],
      requests,
      expect: { acceptedUnits: requests.reduce((sum, r) => sum + r.units, 0), ledgerRows: requests.length },
    };
  },

  // Users on one custom plan whose maxUnitsPerRequest a k6 VU flips between 10 and 30.
  "plan-flip": async (run) => ({
    scenario: "plan-flip",
    accounts: [
      await meteredAccount(`load ${run} plan-flip`, { account: {}, user: { maxUnitsPerRequest: 10 }, userCount: 20 }),
    ],
  }),
};

async function main(): Promise<void> {
  const [scenario, outFile] = process.argv.slice(2);
  const build = scenario ? SCENARIOS[scenario] : undefined;
  if (!build || !outFile) {
    console.error(`usage: node setup.ts <${Object.keys(SCENARIOS).join("|")}> <out.json>`);
    process.exit(2);
  }
  if (!ADMIN_API_KEY) {
    console.error("ADMIN_API_KEY is not set");
    process.exit(2);
  }

  const started = Date.now();
  const output = await build(new Date().toISOString());
  // Write then rename, so k6 never reads a half-written file.
  const tmp = `${outFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(output, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, outFile);
  const users = output.accounts.reduce((sum, a) => sum + a.users.length, 0);
  console.log(`setup ${scenario}: ${output.accounts.length} account(s), ${users} user(s) in ${Date.now() - started} ms`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
