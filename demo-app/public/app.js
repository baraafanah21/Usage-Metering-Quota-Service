// Talks only to the demo server (/api/*). The demo server holds the API keys.

/** Builds an element. Children are nodes or strings; strings become text, never HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (n === null || n === undefined ? "unlimited" : Number(n).toLocaleString("en-US"));

class ApiError extends Error {
  constructor(status, payload) {
    const e = payload?.error ?? {};
    super(e.detail || e.title || `HTTP ${status}`);
    this.status = status;
    this.payload = payload;
  }
}

async function api(path, body) {
  const init = body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(0, { error: { code: "NETWORK_ERROR", detail: `Demo server unreachable: ${err.message}`, source: "browser" } });
  }
  let payload = null;
  try { payload = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) throw new ApiError(res.status, payload);
  return payload;
}

// ---- errors: always visible, never silent ----

function errorText(err) {
  if (!(err instanceof ApiError)) return { who: "Page error", what: String(err?.message ?? err) };
  const e = err.payload?.error ?? {};
  const who = e.source === "metering-api" ? "Metering API" : e.source === "browser" ? "Network" : "Demo server";
  const status = err.status ? `${err.status} ` : "";
  // VALIDATION_ERROR lists each bad field (DESIGN.md §8.1).
  const fields = Array.isArray(e.errors) ? e.errors.map((f) => `${f.path}: ${f.message}`).join("; ") : "";
  return { who, what: `${status}${e.code ?? "ERROR"}${err.message ? ` — ${err.message}` : ""}${fields ? ` (${fields})` : ""}` };
}

function showError(err, context) {
  const { who, what } = errorText(err);
  const box = h("div", { class: "error-msg", role: "alert" },
    h("div", {}, h("strong", {}, `${who} error`), context ? ` while ${context}: ` : ": ", what),
    h("button", { type: "button", onclick: () => box.remove(), "aria-label": "Dismiss" }, "Dismiss"),
  );
  $("#errors").append(box);
}

// ---- shared bits ----

function meter(label, used, allowance, remaining) {
  const pct = allowance ? Math.min(100, (used / allowance) * 100) : 0;
  const nums = allowance === null ? `${fmt(used)} used · no monthly limit` : `${fmt(remaining)} left of ${fmt(allowance)}`;
  return h("div", { class: "meter" },
    h("div", { class: "meter-label" }, h("span", {}, label), h("span", { class: "nums" }, nums)),
    h("div", { class: "meter-bar" }, h("div", { class: "meter-fill", style: `width:${pct}%` })),
  );
}

function planLabel(name, maxPerRequest) {
  return maxPerRequest === null || maxPerRequest === undefined ? `${name} · no max/request` : `${name} · max ${fmt(maxPerRequest)}/request`;
}

function scopeBadge(scope) {
  return h("span", { class: "badge" }, scope === "user" ? "USER LIMIT" : "ACCOUNT LIMIT");
}

function rawJson(exchange, summary = "Raw request / response JSON") {
  return h("details", {}, h("summary", {}, summary), h("pre", {}, JSON.stringify(exchange, null, 2)));
}

/** One plain sentence for why a request was rejected. */
function explain(user, units, reason, remaining) {
  const per = reason.rule === "max_units_per_request";
  if (reason.scope === "user" && per) return `${user} asked for ${fmt(units)}, but ${user}'s plan allows at most ${fmt(reason.limit)} per request.`;
  if (reason.scope === "account" && per) return `${user} asked for ${fmt(units)}, but the shared account allows at most ${fmt(reason.limit)} per request.`;
  if (reason.scope === "user") return `${user} asked for ${fmt(units)}, but has only ${fmt(remaining.user)} left this month.`;
  if (reason.scope === "account") return `${user} has ${fmt(remaining.user)} left, but the shared account has only ${fmt(remaining.account)}.`;
  return reason.message;
}

/** The decision, large: the most visible thing on the page. Used by the cards and the scenario. */
function decisionResult({ user, units, decision, reason, remaining, replayed }, exchange) {
  return h("div", { class: `result ${decision}` },
    h("div", { class: "verdict" },
      h("span", { class: "verdict-word" }, decision === "accepted" ? "ACCEPTED" : "REJECTED"),
      h("span", { class: "verdict-units" }, `${fmt(units)} units`),
    ),
    reason ? h("p", { class: "why" }, scopeBadge(reason.scope), h("span", {}, explain(user, units, reason, remaining))) : null,
    h("div", { class: "remaining" }, `remaining: user ${fmt(remaining.user)} · account ${fmt(remaining.account)}`),
    replayed ? h("div", { class: "replayed" }, h("strong", {}, "replayed: true"), " · same requestId, the stored decision; nothing counted twice") : null,
    exchange ? rawJson(exchange) : null,
  );
}

function fromConsume(exchange) {
  const body = exchange.response.body;
  return {
    user: exchange.request.body.userId,
    units: body.units,
    decision: body.decision,
    reason: body.reason,
    remaining: { user: body.user.remaining, account: body.account.remaining },
    replayed: body.replayed,
  };
}

function errorResult(err) {
  const { who, what } = errorText(err);
  return h("div", { class: "result" },
    h("div", { class: "verdict" }, h("span", { class: "verdict-word" }, "ERROR")),
    h("p", { class: "why" }, `${who}: ${what}`),
    err.payload?.request ? rawJson({ request: err.payload.request, response: err.payload.response }) : null,
  );
}

// ---- free play ----

/** Per user: the last request sent (for Retry) and its result. Kept across re-renders. */
const last = new Map();
let state = null;

function userCard(u) {
  const { user } = u.limits;
  const prev = last.get(u.userId);
  const input = h("input", { type: "number", min: "1", step: "1", value: prev?.request?.units ?? 10, inputmode: "numeric", "aria-label": `Units for ${u.userId}` });

  async function send(path, body) {
    let exchange, err;
    try {
      exchange = await api(path, body);
    } catch (e) {
      err = e;
      showError(e, `processing a document for ${u.userId}`);
    }
    // What was actually sent to /v1/consume, also on an API error, so Retry re-sends
    // the same requestId (the point of retrying after a timeout).
    const sent = exchange?.request?.body ?? err?.payload?.request?.body;
    const request = sent ? { user: sent.userId, units: sent.units, requestId: sent.requestId } : (prev?.request ?? null);
    last.set(u.userId, { request, exchange, err });
    await refresh();
  }

  const processBtn = h("button", {
    type: "button", class: "primary",
    onclick: async () => {
      const units = input.valueAsNumber;
      if (!Number.isFinite(units)) return showError(new Error("Enter a number of units"), `processing for ${u.userId}`);
      processBtn.disabled = true;
      await send("/api/process", { user: u.userId, units });
    },
  }, "Process document");

  // Only once this user has sent something.
  const retryBtn = prev?.request?.requestId
    ? h("button", {
        type: "button", class: "link",
        title: `Re-send requestId ${prev.request.requestId}`,
        onclick: async () => {
          retryBtn.disabled = true;
          await send("/api/retry", prev.request);
        },
      }, "Retry last request (same requestId)")
    : null;

  return h("article", { class: "card" },
    h("div", { class: "card-head" }, h("h3", {}, u.userId), h("span", { class: "plan" }, planLabel(user.planName, user.maxUnitsPerRequest))),
    meter(`${u.userId}'s allowance`, user.used, user.monthlyAllowance, user.remaining),
    h("div", { class: "send" }, input, processBtn),
    prev?.exchange ? decisionResult(fromConsume(prev.exchange), prev.exchange) : prev?.err ? errorResult(prev.err) : null,
    retryBtn,
  );
}

function render() {
  const { account, users, requests, userPlans, demoTeam } = state;
  const m = account.currentMonth;
  const rules = account.plan.rules;
  $("#account").replaceChildren(
    h("div", { class: "account-head" },
      h("h3", {}, `${account.name} · shared account`),
      h("span", { class: "plan" }, `${planLabel(account.plan.name, rules.maxUnitsPerRequest)} · v${account.plan.version} · ${m.month}`)),
    meter("Used by all users together", m.used, rules.monthlyAllowance ?? null, m.remaining),
  );

  $("#users").replaceChildren(...users.map(userCard));

  // Config selects: keep the current choice across refreshes.
  const userSel = $("#cfg-user");
  const keepUser = userSel.value;
  userSel.replaceChildren(...users.map((u) => h("option", { value: u.userId }, `${u.userId} (${u.limits.user.planName})`)));
  if (keepUser) userSel.value = keepUser;
  const planSel = $("#cfg-plan");
  const keepPlan = planSel.value;
  planSel.replaceChildren(...userPlans.map((p) =>
    h("option", { value: p.id }, `${p.name} — ${fmt(p.rules.monthlyAllowance ?? null)}/month, max ${fmt(p.rules.maxUnitsPerRequest ?? null)}`)));
  if (keepPlan) planSel.value = keepPlan;

  $("#cfg-demo-team").textContent = demoTeam.name;
  const form = $("#plan-limits-form");
  if (!form.contains(document.activeElement)) {
    form.monthlyAllowance.value = demoTeam.rules.monthlyAllowance ?? "";
    form.maxUnitsPerRequest.value = demoTeam.rules.maxUnitsPerRequest ?? "";
  }

  $("#history tbody").replaceChildren(
    ...(requests.length === 0
      ? [h("tr", {}, h("td", { colspan: "6", class: "muted" }, "No requests yet."))]
      : requests.map((r) => h("tr", {},
          h("td", {}, r.createdAt.slice(11, 19)),
          h("td", {}, r.userId),
          h("td", {}, fmt(r.units)),
          h("td", { class: r.decision }, r.decision),
          h("td", {}, r.reason ? [scopeBadge(r.reason.scope), " ", h("code", {}, r.reason.rule)] : "—"),
          h("td", { class: "muted" }, h("code", { title: r.requestId }, r.requestId.slice(0, 8) + "…")),
        ))),
  );
}

async function refresh() {
  try {
    state = await api("/api/state");
    render();
  } catch (err) {
    if (err instanceof ApiError && err.payload?.error?.code === "DEMO_NOT_READY") {
      $("#account").textContent = "The demo server is still setting up DocuCorp…";
      setTimeout(refresh, 1500);
      return;
    }
    showError(err, "loading the current state");
  }
}

// ---- configuration ----

function showConfigResult(label, exchange) {
  $("#config-result").replaceChildren(h("div", {}, h("strong", {}, `✓ ${label}`), rawJson(exchange)));
}

$("#user-plan-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.currentTarget;
  try {
    const exchange = await api("/api/config/user-plan", { user: f.user.value, planId: f.planId.value });
    showConfigResult(`${f.user.value} is now on ${exchange.response.body.plan.name}`, exchange);
  } catch (err) {
    showError(err, "changing a user's plan");
  }
  await refresh();
});

$("#plan-limits-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.currentTarget;
  const value = (input) => (input.value === "" ? null : input.valueAsNumber);
  try {
    const exchange = await api("/api/config/plan-limits", {
      monthlyAllowance: value(f.monthlyAllowance),
      maxUnitsPerRequest: value(f.maxUnitsPerRequest),
    });
    const p = exchange.response.body;
    showConfigResult(`${p.name} is now v${p.version}: monthly ${fmt(p.rules.monthlyAllowance ?? null)}, max ${fmt(p.rules.maxUnitsPerRequest ?? null)}`, exchange);
    document.activeElement?.blur();
  } catch (err) {
    showError(err, "changing the plan's limits");
  }
  await refresh();
});

// ---- guided scenario ----

function renderAction(a, showLabel) {
  const check = h("div", { class: `check${a.pass ? "" : " fail"}` }, `${a.pass ? "✓" : "✗"} expected ${a.expected}${a.pass ? "" : `, got ${a.actual}`}`);
  const exchange = { request: a.request, response: a.response };
  let body;
  if (a.kind === "consume" && a.decision) {
    body = decisionResult({
      user: a.request.body.userId,
      units: a.request.body.units,
      decision: a.decision,
      reason: a.reason,
      remaining: a.remaining,
      replayed: false,
    }, exchange);
  } else {
    body = [h("div", { class: "config-done" }, a.label), rawJson(exchange)];
  }
  return h("div", { class: "action" },
    showLabel && a.kind === "consume" ? h("div", { class: "action-label" }, a.label) : null,
    body,
    check,
  );
}

function renderScenario(result) {
  const passed = result.steps.filter((s) => s.pass).length;
  $("#scenario").replaceChildren(
    h("div", { class: "summary" },
      `${result.pass ? "✓" : "✗"} ${passed} of ${result.steps.length} steps as expected`,
      h("span", { class: "muted" }, result.account.name)),
    ...result.steps.map((s) => h("article", { class: "step" },
      h("div", { class: "step-head" },
        h("span", { class: "step-num" }, String(s.number)),
        h("h3", {}, s.title),
        h("span", { class: `step-mark${s.pass ? "" : " fail"}` }, s.pass ? "✓ as expected" : "✗ not as expected")),
      h("p", { class: "step-why" }, s.explanation),
      h("div", { class: "actions" }, s.actions.map((a) => renderAction(a, s.actions.length > 1))),
    )),
  );
}

$("#run-scenario").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  btn.textContent = "Running…";
  try {
    renderScenario(await api("/api/scenario", {}));
  } catch (err) {
    showError(err, "running the guided scenario");
  } finally {
    btn.disabled = false;
    btn.textContent = "Run again";
  }
});

refresh();
