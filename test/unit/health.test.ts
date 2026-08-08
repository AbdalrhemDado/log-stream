import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { createReadiness } from "../../src/shared/readiness.js";

describe("GET /health", () => {
  const apps: ReturnType<typeof buildApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it("is non-ready before startup completes", async () => {
    const readiness = createReadiness();
    const databaseProbe = vi.fn(() => Promise.resolve());
    const app = buildApp({ readiness, databaseProbe });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{"status":"unavailable"}');
    expect(databaseProbe).not.toHaveBeenCalled();
  });

  it("returns 200 only when ready and the database probe succeeds", async () => {
    const readiness = createReadiness();
    readiness.markReady();
    const app = buildApp({ readiness, databaseProbe: () => Promise.resolve() });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"status":"ok"}');
  });

  it("becomes unavailable without exposing credential-bearing probe errors", async () => {
    const readiness = createReadiness();
    readiness.markReady();
    const app = buildApp({
      readiness,
      databaseProbe: () =>
        Promise.reject(
          new Error("postgresql://runtime:private-password@postgres/logstream is unavailable"),
        ),
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{"status":"unavailable"}');
    expect(response.body).not.toContain("private-password");
    expect(readiness.state).toBe("degraded");
  });

  it("recovers after a degraded database probe succeeds", async () => {
    const readiness = createReadiness();
    readiness.markReady();
    const databaseProbe = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(undefined);
    const app = buildApp({ readiness, databaseProbe });
    apps.push(app);

    const unavailable = await app.inject({ method: "GET", url: "/health" });
    const recovered = await app.inject({ method: "GET", url: "/health" });

    expect(unavailable.statusCode).toBe(503);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.body).toBe('{"status":"ok"}');
  });

  it("remains public when an authorization header is supplied", async () => {
    const readiness = createReadiness();
    readiness.markReady();
    const app = buildApp({ readiness, databaseProbe: () => Promise.resolve() });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { authorization: "Bearer unrecognized-load-generator-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"status":"ok"}');
  });
});
