// §11.2 plan-flip: 50 VUs consume 1-30 units while one VU flips the users' plan between
// maxUnitsPerRequest 10 and 30 about every 100 ms. Every accepted ledger row must satisfy
// the limits in its own evaluation snapshot (verify.sql), and nothing may error.
import http from "k6/http";
import { check, sleep } from "k6";
import { API_URL, consume, consumeThresholds, loadSetup, pick, randomInt, uniqueRequestId } from "../lib/common.js";

const setup = loadSetup();
const account = setup.accounts[0];

export const options = {
  scenarios: {
    consumers: { executor: "constant-vus", vus: 50, duration: "60s", exec: "consumer" },
    flipper: { executor: "constant-vus", vus: 1, duration: "60s", exec: "flipper" },
  },
  thresholds: {
    ...consumeThresholds,
    "http_req_failed{name:flip}": ["rate<0.01"],
    "http_reqs{name:flip}": ["count>100"],
  },
};

export function consumer() {
  consume(account.apiKey, { userId: pick(account.users), units: randomInt(1, 30), requestId: uniqueRequestId() });
}

export function flipper() {
  const res = http.patch(
    `${API_URL}/v1/plans/${account.userPlanId}`,
    JSON.stringify({ rules: { maxUnitsPerRequest: __ITER % 2 === 0 ? 30 : 10 } }),
    { headers: { "content-type": "application/json", "x-api-key": account.apiKey }, tags: { name: "flip" } },
  );
  check(res, { "flip: 200": (r) => r.status === 200 });
  sleep(0.1);
}
