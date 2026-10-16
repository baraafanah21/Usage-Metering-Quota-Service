// §11.2 hot-user: 1 user, 100 VUs. Both counter rows (account and user) are hot: the worst case.
import { consume, consumeThresholds, loadSetup, randomInt, uniqueRequestId } from "../lib/common.js";

const setup = loadSetup();
const account = setup.accounts[0];

export const options = {
  scenarios: { "hot-user": { executor: "constant-vus", vus: 100, duration: "60s" } },
  thresholds: consumeThresholds,
};

export default function () {
  consume(account.apiKey, { userId: account.users[0], units: randomInt(1, 10), requestId: uniqueRequestId() });
}
