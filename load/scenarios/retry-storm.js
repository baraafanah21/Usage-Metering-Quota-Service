// §11.2 retry-storm: 100 VUs keep resending the same 100 requests (same requestId, same
// payload). Each must be decided once: one ledger row and one increment per requestId,
// every other answer a replay. verify.sql checks rows and units after the run.
import { consume, consumeThresholds, loadSetup } from "../lib/common.js";

const setup = loadSetup();
const account = setup.accounts[0];
const requests = setup.requests;

export const options = {
  scenarios: { "retry-storm": { executor: "constant-vus", vus: 100, duration: "30s" } },
  thresholds: consumeThresholds,
};

export default function () {
  // VUs start at different offsets and walk the whole set, so every request is sent early
  // and by many VUs at once.
  const r = requests[(__VU * 7 + __ITER) % requests.length];
  consume(account.apiKey, { userId: r.userId, units: r.units, requestId: r.requestId });
}
