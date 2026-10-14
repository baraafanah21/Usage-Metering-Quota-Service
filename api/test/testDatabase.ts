// The test suite only ever talks to this database (compose `db-test`, profile `test`).
// TEST_DATABASE_URL overrides it (CI uses this); DATABASE_URL is deliberately ignored so a
// shell pointed at the dev database can never be used by the test suite.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://metering:metering@localhost:5433/metering_test";
