// §11.2 spread: 200 accounts × 5 users, random small consumes. No two requests are likely
// to want the same counter row, so this is the no-contention baseline.
import { consume, consumeThresholds, loadSetup, pick, randomInt, uniqueRequestId } from "../lib/common.js";

const setup = loadSetup();

export const options = {
  scenarios: { spread: { executor: "constant-vus", vus: 100, duration: "60s" } },
  thresholds: consumeThresholds,
};

export default function () {
  const account = pick(setup.accounts);
  consume(account.apiKey, { userId: pick(account.users), units: randomInt(1, 10), requestId: uniqueRequestId() });
}
