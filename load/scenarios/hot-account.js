// §11.2 hot-account: 1 account, 500 users, 100 VUs. Every consume locks the same account
// counter row, so this measures contention on the shared row.
import { consume, consumeThresholds, loadSetup, pick, randomInt, uniqueRequestId } from "../lib/common.js";

const setup = loadSetup();
const account = setup.accounts[0];

export const options = {
  scenarios: { "hot-account": { executor: "constant-vus", vus: 100, duration: "60s" } },
  thresholds: consumeThresholds,
};

export default function () {
  consume(account.apiKey, { userId: pick(account.users), units: randomInt(1, 10), requestId: uniqueRequestId() });
}
