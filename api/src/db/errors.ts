// Postgres SQLSTATE codes we react to. https://www.postgresql.org/docs/16/errcodes-appendix.html
export const UNIQUE_VIOLATION = "23505";
export const UNDEFINED_TABLE = "42P01";
export const DEADLOCK_DETECTED = "40P01";
/** lock_timeout expired while waiting for a row lock. */
export const LOCK_NOT_AVAILABLE = "55P03";
/** statement_timeout expired (or the query was cancelled). */
export const QUERY_CANCELED = "57014";

interface PgError {
  code?: string;
  constraint?: string;
}

export function pgErrorCode(err: unknown): string | undefined {
  return (err as PgError | null)?.code;
}

/** True if err is a unique violation, optionally on one specific constraint or index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as PgError | null;
  return (
    e?.code === UNIQUE_VIOLATION && (constraint === undefined || e.constraint === constraint)
  );
}
