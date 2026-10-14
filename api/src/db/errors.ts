// Postgres SQLSTATE codes we react to. https://www.postgresql.org/docs/16/errcodes-appendix.html
export const UNIQUE_VIOLATION = "23505";
export const UNDEFINED_TABLE = "42P01";

interface PgError {
  code?: string;
  constraint?: string;
}

/** True if err is a unique violation, optionally on one specific constraint or index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as PgError | null;
  return (
    e?.code === UNIQUE_VIOLATION && (constraint === undefined || e.constraint === constraint)
  );
}
