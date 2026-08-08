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
