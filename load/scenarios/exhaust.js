// §11.2 exhaust: account allowance 10,000; 2,000 concurrent requests × 10 units = 20,000
// requested. Correct means exactly 1,000 accepted (10,000 units) and 1,000 rejected by the
// account's monthly_allowance: verify.sql checks the ledger and counters after the run.
import { consume, consumeThresholds, loadSetup, pick, uniqueRequestId } from "../lib/common.js";

const setup = loadSetup();
const account = setup.accounts[0];

export const options = {
  scenarios: {
    exhaust: { executor: "shared-iterations", vus: 100, iterations: 2000, maxDuration: "2m" },
  },
  thresholds: {
    ...consumeThresholds,
    // Exactly half fits. verify.sql checks the same on the database side.
    consume_accepted: ["count==1000"],
    consume_rejected: ["count==1000"],
  },
};

export default function () {
  consume(account.apiKey, { userId: pick(account.users), units: 10, requestId: uniqueRequestId() });
}
