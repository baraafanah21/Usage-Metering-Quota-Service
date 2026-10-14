import { defineConfig } from "vitest/config";

// Tests always run against the separate test database (compose `db-test`, profile `test`).
// TEST_DATABASE_URL overrides it (CI uses this); DATABASE_URL is deliberately ignored so a
// shell pointed at the dev database can never be used by the test suite.
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://metering:metering@localhost:5433/metering_test";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: {
      DATABASE_URL: testDatabaseUrl,
      ADMIN_API_KEY: "test-admin-key-0123456789abcdef0123456789",
      LOG_LEVEL: "silent",
    },
  },
});
