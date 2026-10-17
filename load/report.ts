// Turns a run's raw files into numbers. Runs in the load-setup container (Node 22, no deps).
//
//   node report.ts metrics <dir> <scenario>   /metrics before/after + pool samples → <scenario>.metrics.json
//   node report.ts line <dir> <scenario>      one-line summary of a finished run
//   node report.ts median <dir>               medians over <dir>/run*/ → <dir>/summary.{json,md}
//
// <dir> is relative to load/, e.g. results/baseline.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const SCENARIOS = ["spread", "hot-account", "hot-user", "exhaust", "retry-storm", "plan-flip"];

// ---- Prometheus text ------------------------------------------------------------------

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function parseProm(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split("\n")) {
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const l of (m[2] ?? "").matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) labels[l[1]!] = l[2]!;
    samples.push({ name: m[1]!, labels, value: Number(m[3]) });
  }
  return samples;
}

const matches = (s: Sample, name: string, labels: Record<string, string>) =>
  s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v);

function value(samples: Sample[], name: string, labels: Record<string, string> = {}): number {
  return samples.filter((s) => matches(s, name, labels)).reduce((sum, s) => sum + s.value, 0);
}

interface HistogramDelta {
  count: number;
  /** Exact: Δsum / Δcount. */
  meanMs: number | null;
  /** Interpolated inside buckets, like PromQL histogram_quantile: approximate. */
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

/** One histogram's observations between two scrapes. */
function histogramDelta(before: Sample[], after: Sample[], name: string, labels: Record<string, string> = {}): HistogramDelta {
  const count = value(after, `${name}_count`, labels) - value(before, `${name}_count`, labels);
  const sum = value(after, `${name}_sum`, labels) - value(before, `${name}_sum`, labels);
  const buckets = after
    .filter((s) => matches(s, `${name}_bucket`, labels))
    .map((s) => ({ le: Number(s.labels.le === "+Inf" ? Infinity : s.labels.le), cum: s.value - value(before, `${name}_bucket`, { ...labels, le: s.labels.le! }) }))
    .sort((a, b) => a.le - b.le);

  const quantile = (q: number): number | null => {
    if (count === 0) return null;
    const rank = q * count;
    let lower = 0;
    let below = 0;
    for (const b of buckets) {
      if (b.cum >= rank) {
        if (b.le === Infinity) return lower * 1000; // beyond the last bound: report the bound
        return (lower + (b.le - lower) * ((rank - below) / (b.cum - below || 1))) * 1000;
      }
      lower = b.le;
      below = b.cum;
    }
    return null;
  };
  const round = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
  return {
    count,
    meanMs: count ? round((sum / count) * 1000) : null,
    p50Ms: round(quantile(0.5)),
    p95Ms: round(quantile(0.95)),
    p99Ms: round(quantile(0.99)),
  };
}

function metrics(dir: string, scenario: string): void {
  const before = parseProm(readFileSync(`.work/${scenario}.before.prom`, "utf8"));
  const after = parseProm(readFileSync(`.work/${scenario}.after.prom`, "utf8"));

  // Lines of "<unix seconds> db_pool_total=N db_pool_idle=N db_pool_waiting=N", every 0.5 s.
  const pool = readFileSync(`.work/${scenario}.pool.txt`, "utf8")
    .split("\n")
    .map((line) => Object.fromEntries([...line.matchAll(/(db_pool_\w+)=(\d+)/g)].map((m) => [m[1]!, Number(m[2])])))
    .filter((s) => "db_pool_waiting" in s);
  const waiting = pool.map((s) => s.db_pool_waiting!);
  const sorted = [...waiting].sort((a, b) => a - b);

  // Two lines of "<unix seconds> <db cpu µs> <api cpu µs>", around the k6 run: cores busy on average.
  const [cpuBefore, cpuAfter] = readFileSync(`.work/${scenario}.cpu.txt`, "utf8").trim().split("\n").map((l) => l.split(" ").map(Number));
  const seconds = cpuAfter![0]! - cpuBefore![0]!;
  const cores = (i: number) => Math.round(((cpuAfter![i]! - cpuBefore![i]!) / 1e6 / seconds) * 100) / 100;

  const delta = (name: string, labels: Record<string, string> = {}) => value(after, name, labels) - value(before, name, labels);
  const out = {
    scenario,
    cpuCores: { db: cores(1), api: cores(2), overSeconds: Math.round(seconds * 10) / 10 },
    poolSamples: pool.length,
    dbPoolTotalMax: Math.max(0, ...pool.map((s) => s.db_pool_total ?? 0)),
    dbPoolWaiting: {
      mean: waiting.length ? Math.round((waiting.reduce((a, b) => a + b, 0) / waiting.length) * 10) / 10 : null,
      median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
      max: sorted.length ? sorted.at(-1) : null,
    },
    consumeTxDuration: histogramDelta(before, after, "consume_tx_duration_seconds"),
    consumePoolAcquire: histogramDelta(before, after, "consume_pool_acquire_seconds"),
    consumeLockHold: histogramDelta(before, after, "consume_lock_hold_seconds"),
    httpConsume200: histogramDelta(before, after, "http_request_duration_seconds", { route: "/v1/consume", method: "POST", status: "200" }),
    decisions: {
      accepted: delta("consume_decisions_total", { decision: "accepted" }),
      rejected: delta("consume_decisions_total", { decision: "rejected" }),
      replays: delta("consume_replays_total"),
      idempotencyConflicts: delta("consume_idempotency_conflicts_total"),
    },
  };
  writeFileSync(`${dir}/${scenario}.metrics.json`, JSON.stringify(out, null, 2) + "\n");
}

// ---- One run --------------------------------------------------------------------------

interface RunNumbers {
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  errorRate: number;
  requests: number;
  verified: boolean;
  poolWaitingMean: number | null;
  txMeanMs: number | null;
  acquireMeanMs: number | null;
  lockHoldMeanMs: number | null;
  dbCpuCores: number;
  apiCpuCores: number;
}

function runNumbers(dir: string, scenario: string): RunNumbers {
  const k6 = JSON.parse(readFileSync(`${dir}/${scenario}.json`, "utf8")).metrics;
  const m = JSON.parse(readFileSync(`${dir}/${scenario}.metrics.json`, "utf8"));
  const duration = k6["http_req_duration{name:consume}"];
  const reqs = k6["http_reqs{name:consume}"];
  return {
    rps: reqs.rate,
    p50: duration.med,
    p95: duration["p(95)"],
    p99: duration["p(99)"],
    errorRate: k6["http_req_failed{name:consume}"].value,
    requests: reqs.count,
    verified: readFileSync(`${dir}/${scenario}.verify.txt`, "utf8").includes("verify OK"),
    poolWaitingMean: m.dbPoolWaiting.mean,
    txMeanMs: m.consumeTxDuration.meanMs,
    acquireMeanMs: m.consumePoolAcquire.meanMs,
    // Absent in results recorded before the metric existed (Phase 6a baseline).
    lockHoldMeanMs: m.consumeLockHold?.meanMs ?? null,
    dbCpuCores: m.cpuCores.db,
    apiCpuCores: m.cpuCores.api,
  };
}

const fmt = (x: number | null, digits = 1) => (x === null ? "–" : x.toFixed(digits));

function line(dir: string, scenario: string): void {
  const r = runNumbers(dir, scenario);
  console.log(
    `${scenario} [${dir}]: ${fmt(r.rps, 0)} req/s, p50 ${fmt(r.p50)} ms, p95 ${fmt(r.p95)} ms, p99 ${fmt(r.p99)} ms, ` +
      `errors ${fmt(r.errorRate * 100, 2)}% of ${r.requests}, pool waiting avg ${fmt(r.poolWaitingMean)}, ` +
      `tx ${fmt(r.txMeanMs, 2)} ms, acquire ${fmt(r.acquireMeanMs, 2)} ms, lock hold ${fmt(r.lockHoldMeanMs, 2)} ms, ` +
      `CPU cores db ${fmt(r.dbCpuCores, 2)} api ${fmt(r.apiCpuCores, 2)}, verify ${r.verified ? "✅" : "❌"}`,
  );
}

// ---- Medians over runs ----------------------------------------------------------------

function median(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

function medians(dir: string): void {
  const runs = readdirSync(dir).filter((d) => /^run\d+$/.test(d)).sort();
  const rows: Record<string, unknown>[] = [];
  const md = [
    `| Scenario | Runs | Req/s | p50 ms | p95 ms | p99 ms | Error rate | Pool waiting (avg) | Tx mean ms | Acquire mean ms | Lock hold mean ms | CPU db | CPU api | verify.sql |`,
    `| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | :-: |`,
  ];
  for (const scenario of SCENARIOS) {
    const per = runs.filter((r) => existsSync(`${dir}/${r}/${scenario}.json`)).map((r) => runNumbers(`${dir}/${r}`, scenario));
    if (per.length === 0) continue;
    const pick = (k: keyof RunNumbers) => median(per.map((p) => p[k] as number | null));
    const row = {
      scenario,
      runs: per.length,
      rps: pick("rps"),
      p50: pick("p50"),
      p95: pick("p95"),
      p99: pick("p99"),
      errorRate: pick("errorRate"),
      poolWaitingMean: pick("poolWaitingMean"),
      txMeanMs: pick("txMeanMs"),
      acquireMeanMs: pick("acquireMeanMs"),
      lockHoldMeanMs: pick("lockHoldMeanMs"),
      dbCpuCores: pick("dbCpuCores"),
      apiCpuCores: pick("apiCpuCores"),
      verified: per.every((p) => p.verified),
      perRun: per,
    };
    rows.push(row);
    md.push(
      `| ${scenario} | ${per.length} | ${fmt(row.rps, 0)} | ${fmt(row.p50)} | ${fmt(row.p95)} | ${fmt(row.p99)} | ` +
        `${fmt((row.errorRate ?? 0) * 100, 2)}% | ${fmt(row.poolWaitingMean)} | ${fmt(row.txMeanMs, 2)} | ${fmt(row.acquireMeanMs, 2)} | ${fmt(row.lockHoldMeanMs, 2)} | ${fmt(row.dbCpuCores, 2)} | ${fmt(row.apiCpuCores, 2)} | ` +
        `${row.verified ? "✅" : "❌"} ${per.filter((p) => p.verified).length}/${per.length} |`,
    );
  }
  writeFileSync(`${dir}/summary.json`, JSON.stringify(rows, null, 2) + "\n");
  writeFileSync(`${dir}/summary.md`, md.join("\n") + "\n");
  console.log(md.join("\n"));
}

const [command, dir, scenario] = process.argv.slice(2);
if (command === "metrics" && dir && scenario) metrics(dir, scenario);
else if (command === "line" && dir && scenario) line(dir, scenario);
else if (command === "median" && dir) medians(dir);
else {
  console.error("usage: node report.ts metrics|line <dir> <scenario> | median <dir>");
  process.exit(2);
}
