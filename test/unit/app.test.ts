import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/app-config.js";

describe("buildApp", () => {
  const apps: ReturnType<typeof buildApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it("supports injection without binding a network port", async () => {
    const app = buildApp();
    apps.push(app);

    expect(app.server.listening).toBe(false);

    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(404);
    expect(app.server.listening).toBe(false);
  });

  it("generates a distinct bounded request ID for each request", async () => {
    const app = buildApp();
    apps.push(app);

    const first = await app.inject({ method: "GET", url: "/" });
    const second = await app.inject({ method: "GET", url: "/" });
    const firstRequestId = first.headers["x-request-id"];
    const secondRequestId = second.headers["x-request-id"];

    expect(firstRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(secondRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(secondRequestId).not.toBe(firstRequestId);
  });

  it("ignores an untrusted client request ID", async () => {
    const app = buildApp();
    apps.push(app);
    const hostileRequestId = "hostile".repeat(512);

    const response = await app.inject({
      method: "GET",
      url: "/",
      headers: {
        "request-id": hostileRequestId,
        "x-request-id": hostileRequestId,
      },
    });
    const responseRequestId = response.headers["x-request-id"];

    expect(responseRequestId).not.toBe(hostileRequestId);
    expect(responseRequestId).toHaveLength(36);
  });
});

describe("loadConfig", () => {
  it("uses container-friendly defaults", () => {
    expect(loadConfig({})).toEqual({
      host: "0.0.0.0",
      port: 8080,
      logLevel: "info",
    });
  });

  it("parses supported environment values", () => {
    expect(loadConfig({ HOST: "127.0.0.1", PORT: "9000", LOG_LEVEL: "debug" })).toEqual({
      host: "127.0.0.1",
      port: 9000,
      logLevel: "debug",
    });
  });

  it("rejects a partially numeric port", () => {
    expect(() => loadConfig({ PORT: "8080abc" })).toThrow(
      "PORT must be a base-10 integer between 1 and 65535.",
    );
  });
});
