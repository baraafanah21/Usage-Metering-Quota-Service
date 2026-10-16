// Months are UTC calendar months (§16.9). The API speaks "YYYY-MM"; the database stores the
// first day of the month as a date (§4.1).

/** "YYYY-MM" with a real month (01–12) and a year Postgres can store (0001–9999). */
export const MONTH_PATTERN = /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/;

/** "2026-10" → "2026-10-01", the value of the `month` columns. */
export function monthStart(month: string): string {
  return `${month}-01`;
}
