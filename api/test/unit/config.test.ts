import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";

const valid = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  ADMIN_API_KEY: "a".repeat(32),
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig(valid)).toEqual({
      ...valid,
      PORT: 3000,
      LOG_LEVEL: "info",
      DB_POOL_MAX: 20,
    });
  });

  it("coerces numeric env strings", () => {
    const config = loadConfig({ ...valid, PORT: "8080", DB_POOL_MAX: "5" });
    expect(config.PORT).toBe(8080);
    expect(config.DB_POOL_MAX).toBe(5);
  });

  it("fails with every invalid variable named", () => {
    const load = () =>
      loadConfig({ DATABASE_URL: "mysql://x", ADMIN_API_KEY: "short", PORT: "abc" });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/DATABASE_URL/);
    expect(load).toThrow(/ADMIN_API_KEY/);
    expect(load).toThrow(/PORT/);
  });

  it("fails when required variables are missing", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*ADMIN_API_KEY/);
  });
});
