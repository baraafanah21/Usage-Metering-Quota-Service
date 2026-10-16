// Postgres SQLSTATE codes we react to. https://www.postgresql.org/docs/16/errcodes-appendix.html
export const UNIQUE_VIOLATION = "23505";
export const UNDEFINED_TABLE = "42P01";
export const DEADLOCK_DETECTED = "40P01";
/** lock_timeout expired while waiting for a row lock. */
export const LOCK_NOT_AVAILABLE = "55P03";
/** statement_timeout expired (or the query was cancelled). */
export const QUERY_CANCELED = "57014";

/** SQLSTATE class 08 (connection exception) and the server-shutdown codes 57P01–57P03. */
const CONNECTION_SQLSTATE = /^(08...|57P0[123])$/;
/** Node socket errors that mean the database is unreachable or dropped us. */
const CONNECTION_ERRNO = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EHOSTUNREACH"]);
// pg and pg-pool raise these as plain Errors without a code (pg-pool/index.js, pg/lib/client.js).
const CONNECTION_MESSAGES = new Set([
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
  "Connection terminated unexpectedly",
]);

interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
  /** Set by Node on an AggregateError when it tried several addresses. */
  errors?: unknown[];
}

export function pgErrorCode(err: unknown): string | undefined {
  return (err as PgError | null)?.code;
}

/**
 * True if err means "could not talk to the database" rather than "the query was wrong":
 * refused, reset or timed-out connections, and Postgres refusing or ending the session.
 */
export function isConnectionError(err: unknown): boolean {
  const e = err as PgError | null;
  if (typeof e !== "object" || e === null) return false;
  if (typeof e.code === "string" && (CONNECTION_SQLSTATE.test(e.code) || CONNECTION_ERRNO.has(e.code))) {
    return true;
  }
  if (typeof e.message === "string" && CONNECTION_MESSAGES.has(e.message)) return true;
  return Array.isArray(e.errors) && e.errors.some(isConnectionError);
}

/** True if err is a unique violation, optionally on one specific constraint or index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as PgError | null;
  return (
    e?.code === UNIQUE_VIOLATION && (constraint === undefined || e.constraint === constraint)
  );
}
