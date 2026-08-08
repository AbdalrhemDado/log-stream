import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { BadRequestError, TransientServiceError } from "../../src/shared/app-error.js";
import { mapErrorToHttp } from "../../src/shared/error-handler.js";

describe("central error handler", () => {
  const apps: ReturnType<typeof buildApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it("maps a typed client error to its safe public envelope", async () => {
    const app = buildApp();
    apps.push(app);
    app.get("/typed-error", () => {
      throw new BadRequestError("Invalid query parameter.");
    });

    const response = await app.inject({ method: "GET", url: "/typed-error" });

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('{"error":"Invalid query parameter."}');
    expect(response.headers["retry-after"]).toBeUndefined();
  });

  it("maps only an explicit transient error to 503", async () => {
    const app = buildApp();
    apps.push(app);
    app.get("/transient-error", () => {
      throw new TransientServiceError();
    });

    const response = await app.inject({ method: "GET", url: "/transient-error" });

    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{"error":"Service temporarily unavailable."}');
    expect(response.headers["retry-after"]).toBe("30");
  });

  it("maps an unexpected exception to generic 500 without leaking details", async () => {
    const app = buildApp();
    apps.push(app);
    app.get("/unexpected-error", () => {
      throw new Error("database password=secret and private stack detail");
    });

    const response = await app.inject({ method: "GET", url: "/unexpected-error" });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('{"error":"Internal server error."}');
    expect(response.body).not.toContain("password");
    expect(response.body).not.toContain("secret");
    expect(response.body).not.toContain("stack");
    expect(response.headers["retry-after"]).toBeUndefined();
  });

  it("maps malformed JSON to a safe 400 envelope", async () => {
    const app = buildApp();
    apps.push(app);
    app.post("/json", () => ({ accepted: true }));

    const response = await app.inject({
      method: "POST",
      url: "/json",
      headers: { "content-type": "application/json" },
      payload: '{"broken":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('{"error":"Malformed JSON request body."}');
    expect(response.headers["retry-after"]).toBeUndefined();
  });

  it("preserves a Fastify schema-validation 400 with a safe envelope", async () => {
    const app = buildApp();
    apps.push(app);
    app.post(
      "/validated-json",
      {
        schema: {
          body: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        },
      },
      () => ({ accepted: true }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/validated-json",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('{"error":"Invalid request."}');
    expect(response.headers["retry-after"]).toBeUndefined();
  });

  it("preserves Fastify's unsupported-content-type 415 with a safe envelope", async () => {
    const app = buildApp();
    apps.push(app);
    app.post("/json-only", () => ({ accepted: true }));

    const response = await app.inject({
      method: "POST",
      url: "/json-only",
      headers: { "content-type": "application/xml" },
      payload: "<request />",
    });

    expect(response.statusCode).toBe(415);
    expect(response.body).toBe('{"error":"Invalid request."}');
    expect(response.headers["retry-after"]).toBeUndefined();
  });

  it("preserves Fastify's body-limit 413 with a safe envelope", async () => {
    const app = buildApp();
    apps.push(app);
    app.post("/limited-json", { bodyLimit: 8 }, () => ({ accepted: true }));

    const response = await app.inject({
      method: "POST",
      url: "/limited-json",
      headers: { "content-type": "application/json" },
      payload: '{"value":"too large"}',
    });

    expect(response.statusCode).toBe(413);
    expect(response.body).toBe('{"error":"Invalid request."}');
    expect(response.headers["retry-after"]).toBeUndefined();
  });

  it("does not trust an ordinary object with a client status code", () => {
    const mapped = mapErrorToHttp({ statusCode: 400 });

    expect(mapped.statusCode).toBe(500);
    expect(mapped.body).toEqual({ error: "Internal server error." });
    expect(mapped.expected).toBe(false);
    expect(mapped.retryAfterSeconds).toBeUndefined();
  });
});
