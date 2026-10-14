import { defineConfig } from "vitest/config";
import { TEST_DATABASE_URL } from "./test/testDatabase.js";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Migrates and seeds the test database once before any test file runs.
    globalSetup: ["test/globalSetup.ts"],
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      ADMIN_API_KEY: "test-admin-key-0123456789abcdef0123456789",
      LOG_LEVEL: "silent",
    },
  },
});
