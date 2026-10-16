import type { Exchange, MeteringClient } from "./metering.js";

/**
 * The client application's only metering call: ask before processing a document.
 *
 * Free play and the guided scenario both go through here. Plan changes are data sent to
 * the API (PATCH a plan, PUT a user's plan); this function never changes to follow them.
 * The same requestId is sent again on a retry, so a timeout can never count a document twice.
 */
export function checkQuotaBeforeProcessing(
  api: MeteringClient,
  doc: { user: string; units: number; requestId: string },
): Promise<Exchange> {
  return api.call("POST", "/v1/consume", { userId: doc.user, units: doc.units, requestId: doc.requestId });
}
