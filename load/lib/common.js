// Shared by every scenario in load/scenarios/. Run through load/run.sh, which sets
// API_URL (the api by compose service name) and SETUP_FILE (written by load/setup.ts).
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

export const API_URL = __ENV.API_URL || "http://api:3000";

// Consume answers 200 for accepted and rejected alike (a rejection is a business outcome,
// §6.1). Anything else (400, 409, 503 SERVICE_BUSY, 5xx) is an error in these scenarios.
http.setResponseCallback(http.expectedStatuses(200));

const accepted = new Counter("consume_accepted");
const rejected = new Counter("consume_rejected");
const replayed = new Counter("consume_replayed");

/** The data load/setup.ts created for this run. Read once per VU, in the init context. */
export function loadSetup() {
  if (!__ENV.SETUP_FILE) throw new Error("SETUP_FILE is not set; run scenarios through load/run.sh");
  return JSON.parse(open(__ENV.SETUP_FILE));
}

/**
 * Thresholds every scenario shares. The tagged sub-metrics also put consume-only numbers in
 * the summary export (setup-free, but plan-flip mixes in PATCH requests).
 */
export const consumeThresholds = {
  "http_req_failed{name:consume}": ["rate<0.01"],
  "http_req_duration{name:consume}": ["p(99)<2000"],
  "http_reqs{name:consume}": ["count>0"],
  checks: ["rate>0.99"],
};

export function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

/** A requestId unique within the run: fresh accounts per run make it unique per account too. */
export function uniqueRequestId() {
  return `${__VU}-${__ITER}-${Math.random().toString(36).slice(2, 10)}`;
}

export function consume(apiKey, body) {
  const res = http.post(`${API_URL}/v1/consume`, JSON.stringify(body), {
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    tags: { name: "consume" },
  });
  const decision = res.status === 200 ? res.json("decision") : undefined;
  check(res, { "consume: 200 with a decision": () => decision === "accepted" || decision === "rejected" });
  if (decision === "accepted") accepted.add(1);
  if (decision === "rejected") rejected.add(1);
  if (decision && res.json("replayed") === true) replayed.add(1);
  return res;
}
