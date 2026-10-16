import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Account, EffectiveLimits, LedgerEntry, Plan, User } from "./api-types.js";
import { bootstrap, type DocuCorp } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { checkQuotaBeforeProcessing } from "./documents.js";
import { log } from "./log.js";
import { MeteringClient, MeteringError } from "./metering.js";
import { runScenario } from "./scenario.js";

const config = loadConfig();
const admin = MeteringClient.admin(config.METERING_API_URL, config.ADMIN_API_KEY);
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

/** Set once bootstrap finishes; until then /api answers 503. */
let docucorp: DocuCorp | undefined;

// ---- request bodies from the page ----

const user = z.string().min(1).max(200);
// Units are passed through as sent, so the API's own validation errors reach the page.
const units = z.number();
const processBody = z.strictObject({ user, units });
const retryBody = z.strictObject({ user, units, requestId: z.string().min(1).max(200) });
const limit = z.number().nullable().optional();
const planLimitsBody = z.strictObject({ monthlyAllowance: limit, maxUnitsPerRequest: limit });
const userPlanBody = z.strictObject({ user, planId: z.string().min(1) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new DemoError(400, "INVALID_REQUEST", z.prettifyError(result.error));
  return result.data;
}

class DemoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

function ready(): DocuCorp {
  if (!docucorp) throw new DemoError(503, "DEMO_NOT_READY", "The demo is still setting up DocuCorp. Try again in a few seconds.");
  return docucorp;
}

// ---- app ----

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

// Safety net for the rule "no API key reaches the browser": a JSON body that contains
// anything shaped like an mk_ key is never sent; it is logged and replaced by a 500.
const KEY_PATTERN = /mk_[A-Za-z0-9]{8,}/;
app.use("/api", (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (KEY_PATTERN.test(JSON.stringify(body) ?? "")) {
      log("error", "blocked a response containing an API key", { path: req.originalUrl });
      res.status(500);
      return json({ error: { code: "KEY_LEAK_BLOCKED", detail: "Response withheld: it contained an API key", source: "demo" } });
    }
    return json(body);
  };
  next();
});

app.get("/health/ready", (_req, res) => {
  res.status(docucorp ? 200 : 503).json({ status: docucorp ? "ok" : "starting" });
});

app.get("/api/state", async (_req, res) => {
  const { api, demoTeamPlanId } = ready();
  const [account, { users }, { requests }, { plans: userPlans }, demoTeam] = await Promise.all([
    api.json<Account>("GET", "/v1/account"),
    api.json<{ users: User[] }>("GET", "/v1/users?limit=100"),
    api.json<{ requests: LedgerEntry[] }>("GET", "/v1/requests?limit=10"),
    api.json<{ plans: Plan[] }>("GET", "/v1/plans?scope=user"),
    api.json<Plan>("GET", `/v1/plans/${demoTeamPlanId}`),
  ]);
  const limits = await Promise.all(
    users.map((u) => api.json<EffectiveLimits>("GET", `/v1/users/${encodeURIComponent(u.externalId)}/limits`)),
  );
  res.json({
    account: { name: account.name, plan: account.plan, currentMonth: account.currentMonth },
    users: users.map((u, i) => ({ userId: u.externalId, limits: limits[i] })),
    requests,
    userPlans: userPlans.map(({ id, name, rules }) => ({ id, name, rules })),
    demoTeam: { id: demoTeam.id, name: demoTeam.name, version: demoTeam.version, rules: demoTeam.rules },
  });
});

/** Sends one consume and answers with the raw exchange; a non-2xx keeps the API's status. */
async function sendConsume(res: Response, doc: { user: string; units: number; requestId: string }) {
  const exchange = await checkQuotaBeforeProcessing(ready().api, doc);
  res.json(exchange);
}

app.post("/api/process", async (req, res) => {
  const { user, units } = parse(processBody, req.body);
  // A new document gets a new id. The page keeps it so "Retry" can send it again.
  await sendConsume(res, { user, units, requestId: randomUUID() });
});

app.post("/api/retry", async (req, res) => {
  await sendConsume(res, parse(retryBody, req.body));
});

app.post("/api/config/plan-limits", async (req, res) => {
  const { api, demoTeamPlanId } = ready();
  const rules = parse(planLimitsBody, req.body);
  res.json(await api.call("PATCH", `/v1/plans/${demoTeamPlanId}`, { rules }));
});

app.post("/api/config/user-plan", async (req, res) => {
  const { user, planId } = parse(userPlanBody, req.body);
  res.json(await ready().api.call("PUT", `/v1/users/${encodeURIComponent(user)}/plan`, { planId }));
});

app.post("/api/scenario", async (_req, res) => {
  ready();
  res.json(await runScenario(admin, config.METERING_API_URL));
});

app.use("/api", (_req, _res, next) => next(new DemoError(404, "NOT_FOUND", "No such demo endpoint")));

app.use(express.static(publicDir));

// Errors keep their source, so the page can say whether the demo or the API refused.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof MeteringError) {
    const problem = (err.exchange.response.body ?? {}) as { title?: string; detail?: string; errors?: unknown };
    // The raw exchange goes along, so the page can show the API's problem+json as sent.
    res.status(err.status).json({
      error: { code: err.code, title: problem.title, detail: problem.detail, errors: problem.errors, source: "metering-api" },
      ...err.exchange,
    });
    return;
  }
  if (err instanceof DemoError) {
    res.status(err.status).json({ error: { code: err.code, detail: err.detail, source: "demo" } });
    return;
  }
  // Malformed JSON from the page, as reported by express.json().
  const status = (err as { status?: number }).status;
  if (status && status >= 400 && status < 500) {
    res.status(status).json({ error: { code: "INVALID_REQUEST", detail: (err as Error).message, source: "demo" } });
    return;
  }
  log("error", "unexpected error", { error: (err as Error).stack ?? String(err) });
  res.status(500).json({ error: { code: "INTERNAL_ERROR", detail: "Unexpected demo server error", source: "demo" } });
});

const server = app.listen(config.PORT, () => {
  log("info", "demo listening", { port: config.PORT, meteringApi: config.METERING_API_URL });
});

bootstrap(config).then(
  (result) => {
    docucorp = result;
    log("info", "demo ready", { accountId: result.accountId, demoTeamPlanId: result.demoTeamPlanId });
  },
  (err: unknown) => {
    const detail = err instanceof MeteringError ? err.message : (err as Error).stack;
    log("error", "bootstrap failed", { error: detail });
    process.exit(1);
  },
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  });
}
