import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createPool } from "../../src/db/pool.js";
import { ADMIN_KEY, logger, setupTestApp } from "../helpers.js";

const { app } = setupTestApp();

describe("GET /health/live", () => {
  it("returns 200", async () => {
    const res = await request(app).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /health/ready", () => {
  it("returns 200 when the database is up and migrated", async () => {
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("returns a problem+json 503 when the database is unreachable", async () => {
    // Port 1 on localhost: nothing listens there, so the connection is refused immediately.
    const deadPool = createPool({ connectionString: "postgres://x:x@127.0.0.1:1/x", max: 1 }, logger);
    try {
      const res = await request(createApp({ pool: deadPool, logger, adminApiKey: ADMIN_KEY })).get("/health/ready");
      expect(res.status).toBe(503);
      expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
      expect(res.body).toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
    } finally {
      await deadPool.end();
    }
  });
});

describe("request ids and errors", () => {
  it("returns a problem+json 404 with a request id for an unknown route", async () => {
    const res = await request(app).get("/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    const requestId = res.headers["x-request-id"];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body).toEqual({
      type: "about:blank",
      title: "Not found",
      status: 404,
      code: "NOT_FOUND",
      detail: "No route for GET /does-not-exist",
      requestId,
    });
  });

  it("echoes a valid incoming X-Request-Id", async () => {
    const res = await request(app).get("/health/live").set("X-Request-Id", "trace-abc.123");
    expect(res.headers["x-request-id"]).toBe("trace-abc.123");
  });

  it("replaces an unsafe incoming X-Request-Id", async () => {
    const res = await request(app).get("/health/live").set("X-Request-Id", "bad id\twith spaces");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns problem+json 400 for malformed JSON without leaking parser details", async () => {
    const res = await request(app)
      .post("/health/live")
      .set("Content-Type", "application/json")
      .send("{not json");

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ code: "INVALID_JSON", requestId: res.headers["x-request-id"] });
    expect(JSON.stringify(res.body)).not.toMatch(/stack|at \w+ \(/);
  });

  it("returns problem+json 413 for a body over the size limit", async () => {
    const res = await request(app)
      .post("/health/live")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ blob: "x".repeat(200 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });
});
