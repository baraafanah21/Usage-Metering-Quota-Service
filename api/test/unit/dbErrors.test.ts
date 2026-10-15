import { describe, expect, it } from "vitest";
import { isConnectionError } from "../../src/db/errors.js";

const withCode = (code: string) => Object.assign(new Error("x"), { code });

describe("isConnectionError", () => {
  it.each([
    ["08000 connection_exception", withCode("08000")],
    ["08001 cannot establish connection", withCode("08001")],
    ["08006 connection_failure", withCode("08006")],
    ["08P01 protocol_violation", withCode("08P01")],
    ["57P01 admin_shutdown", withCode("57P01")],
    ["57P02 crash_shutdown", withCode("57P02")],
    ["57P03 cannot_connect_now", withCode("57P03")],
    ["ECONNREFUSED", withCode("ECONNREFUSED")],
    ["ECONNRESET", withCode("ECONNRESET")],
    ["pg-pool connect timeout", new Error("timeout exceeded when trying to connect")],
    ["pg client connect timeout", new Error("Connection terminated due to connection timeout")],
    ["server went away mid-query", new Error("Connection terminated unexpectedly")],
    ["AggregateError of refusals", Object.assign(new AggregateError([withCode("ECONNREFUSED")]), { code: undefined })],
  ])("%s → true", (_name, err) => {
    expect(isConnectionError(err)).toBe(true);
  });

  it.each([
    ["23505 unique_violation", withCode("23505")],
    ["57014 query_canceled (SERVICE_BUSY, not an outage)", withCode("57014")],
    ["55P03 lock_not_available", withCode("55P03")],
    ["40P01 deadlock", withCode("40P01")],
    ["57P04 database_dropped", withCode("57P04")],
    ["plain error", new Error("boom")],
    ["null", null],
    ["string", "ECONNREFUSED"],
  ])("%s → false", (_name, err) => {
    expect(isConnectionError(err)).toBe(false);
  });
});
