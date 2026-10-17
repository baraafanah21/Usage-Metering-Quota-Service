import type { Pool, PoolClient } from "pg";
import {
  DEADLOCK_DETECTED,
  isUniqueViolation,
  LOCK_NOT_AVAILABLE,
  pgErrorCode,
  QUERY_CANCELED,
} from "../db/errors.js";
import { type TxTiming, withTransaction } from "../db/tx.js";
import { AppError } from "../domain/errors.js";
import {
  type Decision,
  type Evaluation,
  evaluate,
  evaluateStateless,
  toRules,
  type Violation,
} from "../domain/rules.js";
import {
  consumeDecisions,
  consumeIdempotencyConflicts,
  consumeLockHold,
  consumePoolAcquire,
  consumeReplays,
  consumeTxDuration,
} from "../metrics.js";
import {
  findConsumeContext,
  findRequest,
  recordDecision,
  LEDGER_REQUEST_UNIQUE,
  type StoredRequest,
} from "../repositories/requests.js";
import { lockCounters, readCounters } from "../repositories/usage.js";
import type { UserWithPlans } from "../repositories/users.js";
import { type LevelLimits, levelLimits, userNotFound } from "./users.js";

export interface ConsumeInput {
  /** The user's externalId. */
  userId: string;
  units: number;
  requestId: string;
}

/** The §6.1 response. Stored verbatim in the ledger, so a replay returns exactly this. */
export interface ConsumeResponse {
  requestId: string;
  decision: Decision;
  units: number;
  /** "YYYY-MM" */
  month: string;
  /** Present only when rejected: the first violation in §5 order. */
  reason?: Violation;
  violations: Violation[];
  /** For an accepted request, used/remaining are after this request's increment. */
  account: LevelLimits;
  user: LevelLimits;
  replayed: boolean;
}

// Bounds on how long one consume may wait under contention (§10). Both are SET LOCAL, so
// they end with the transaction and never leak to the next user of the pooled connection.
// Sent together with BEGIN.
const TX_TIMEOUTS = "SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'";

/**
 * POST /v1/consume (DESIGN.md §6). Decides whether `units` may be consumed for the user and
 * records the decision, exactly once per (account, requestId), whatever the concurrency.
 */
export async function consume(pool: Pool, accountId: string, input: ConsumeInput): Promise<ConsumeResponse> {
  for (let attempt = 1; ; attempt++) {
    // Set by decide() once the account row is locked; the lock is held until COMMIT ends.
    let lockedAt: number | undefined;
    const observeTx = (timing: TxTiming) => {
      consumePoolAcquire.observe(timing.acquire);
      consumeTxDuration.observe(timing.tx);
      if (lockedAt !== undefined) consumeLockHold.observe((performance.now() - lockedAt) / 1000);
    };
    try {
      const response = await withTransaction(
        pool,
        (client) => decide(client, accountId, input, () => (lockedAt = performance.now())),
        { setup: TX_TIMEOUTS, observe: observeTx },
      );
      return counted(response);
    } catch (err) {
      // An identical request recorded its decision first and ours rolled back entirely,
      // including any counter increment. Answer with the winner's decision.
      if (isUniqueViolation(err, LEDGER_REQUEST_UNIQUE)) {
        return counted(await replayWinner(pool, accountId, input, err));
      }

      const code = pgErrorCode(err);
      // Can't happen with the fixed lock order (account, then user), but Postgres has the
      // final say. The transaction committed nothing, so one retry is safe.
      if (code === DEADLOCK_DETECTED && attempt === 1) continue;
      // Waited too long for a lock or a statement. Nothing committed: retrying is safe.
      if (code === LOCK_NOT_AVAILABLE || code === QUERY_CANCELED || code === DEADLOCK_DETECTED) {
        throw new AppError(
          503,
          "SERVICE_BUSY",
          "Service busy",
          "Too much contention on this account right now; retry with the same requestId",
          { cause: err },
        );
      }
      throw err;
    }
  }
}

/** Counts a committed outcome (§12): a new decision, or a replay of a recorded one. */
function counted(response: ConsumeResponse): ConsumeResponse {
  if (response.replayed) {
    consumeReplays.inc();
  } else {
    consumeDecisions.inc({
      decision: response.decision,
      scope: response.reason?.scope ?? "none",
      rule: response.reason?.rule ?? "none",
    });
  }
  return response;
}

/** The whole decision, inside one transaction. Throwing anywhere rolls everything back. */
async function decide(
  client: PoolClient,
  accountId: string,
  input: ConsumeInput,
  onLocked: () => void,
): Promise<ConsumeResponse> {
  // 1-2. Both lookups in one round trip: the decision already recorded for this requestId,
  //    and the user with both plans that apply, plus the month.
  const { stored, found } = await findConsumeContext(accountId, input.userId, input.requestId, client);

  // 1. Idempotency. A requestId names one decision forever: if it is already recorded,
  //    return that decision (accepted or rejected) and touch nothing. Callers retry on
  //    timeouts, and this is what makes those retries safe (§6.4).
  if (stored) return replayOf(stored, input);

  // 2. The user lookup is scoped by accountId, so another account's user is simply not
  //    found. Nothing is recorded for an unknown user, so the caller can register it and
  //    resend the same requestId.
  if (!found) throw userNotFound(input.userId);
  const accountRules = toRules(found.accountPlan.rules);
  const userRules = toRules(found.userPlan.rules);

  // 3. Per-request limits need no counters, so check them before taking any lock: an
  //    oversized request can't make other requests on the account wait. The counters are
  //    read without a lock, only to show used/remaining in the response.
  const stateless = evaluateStateless({
    units: input.units,
    account: { rules: accountRules },
    user: { rules: userRules },
  });
  if (stateless.decision === "rejected") {
    const used = await readCounters(accountId, found.user.id, found.month, client);
    return record(client, accountId, input, found, stateless, used);
  }

  // 4. Lock the account counter row, then the user's, in one statement. The account row is
  //    the one that serializes competing requests (§6.3), and the fixed order means no two
  //    consumes can ever wait on each other in a cycle. It also creates the month's rows.
  //    From here to COMMIT the account row is locked: 3 round trips (this, record, COMMIT).
  const { accountUsed, userUsed } = await lockCounters(accountId, found.user.id, found.month, client);
  onLocked();

  // 5. Evaluate every rule against counters nobody else can change until we commit.
  const evaluation = evaluate({
    units: input.units,
    account: { rules: accountRules, used: accountUsed },
    user: { rules: userRules, used: userUsed },
  });

  // 6-8. Record the decision and, if accepted, add the units at both levels, or at neither
  //    (no partial acceptance), in one statement; withTransaction commits when this returns.
  const delta = evaluation.decision === "accepted" ? input.units : 0;
  return record(client, accountId, input, found, evaluation, {
    accountUsed: accountUsed + delta,
    userUsed: userUsed + delta,
  });
}

/**
 * Builds the response and appends it to the ledger with the plan versions it was evaluated
 * against; an accepted decision's units go to both counters in the same statement. The stored
 * body is the replay, so history survives later plan edits (§6.4).
 */
async function record(
  client: PoolClient,
  accountId: string,
  input: ConsumeInput,
  found: UserWithPlans,
  evaluation: Evaluation,
  used: { accountUsed: number; userUsed: number },
): Promise<ConsumeResponse> {
  const response: ConsumeResponse = {
    requestId: input.requestId,
    decision: evaluation.decision,
    units: input.units,
    month: found.month.slice(0, 7),
    ...(evaluation.reason && { reason: evaluation.reason }),
    violations: evaluation.violations,
    account: levelLimits(found.accountPlan, used.accountUsed),
    user: levelLimits(found.userPlan, used.userUsed),
    replayed: false,
  };

  await recordDecision(
    accountId,
    {
      userId: found.user.id,
      requestId: input.requestId,
      units: input.units,
      decision: evaluation.decision,
      rejectScope: evaluation.reason?.scope ?? null,
      rejectRule: evaluation.reason?.rule ?? null,
      month: found.month,
      accountPlanId: found.accountPlan.id,
      accountPlanVersion: found.accountPlan.version,
      userPlanId: found.userPlan.id,
      userPlanVersion: found.userPlan.version,
      response,
    },
    client,
  );
  return response;
}

/**
 * The stored decision for a retried requestId. It is the response as it was at decision
 * time (used/remaining then, not now). A different payload under the same id is a client bug.
 */
function replayOf(stored: StoredRequest, input: ConsumeInput): ConsumeResponse {
  if (stored.externalId !== input.userId || stored.units !== input.units) {
    consumeIdempotencyConflicts.inc();
    throw new AppError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "requestId already used",
      `requestId '${input.requestId}' was already used for a different request (userId '${stored.externalId}', units ${stored.units})`,
    );
  }
  return { ...inContractOrder(stored.response as ConsumeResponse), replayed: true };
}

// jsonb stores object keys in its own order (by length, then bytes), not insertion order.
// Rebuild the stored body field by field so a replay reads exactly like the original.
export function inContractOrder(r: ConsumeResponse): ConsumeResponse {
  const violation = (v: Violation): Violation => ({
    scope: v.scope,
    rule: v.rule,
    limit: v.limit,
    actual: v.actual,
    message: v.message,
  });
  const level = (l: LevelLimits): LevelLimits => ({
    planId: l.planId,
    planName: l.planName,
    planVersion: l.planVersion,
    monthlyAllowance: l.monthlyAllowance,
    maxUnitsPerRequest: l.maxUnitsPerRequest,
    used: l.used,
    remaining: l.remaining,
  });
  return {
    requestId: r.requestId,
    decision: r.decision,
    units: r.units,
    month: r.month,
    ...(r.reason && { reason: violation(r.reason) }),
    violations: r.violations.map(violation),
    account: level(r.account),
    user: level(r.user),
    replayed: r.replayed,
  };
}

/** After losing the race on the ledger's unique key: the winner has committed, read its row. */
async function replayWinner(
  pool: Pool,
  accountId: string,
  input: ConsumeInput,
  original: unknown,
): Promise<ConsumeResponse> {
  const winner = await findRequest(accountId, input.requestId, pool);
  if (!winner) throw original; // a unique violation implies a committed row; should not happen
  return replayOf(winner, input);
}
