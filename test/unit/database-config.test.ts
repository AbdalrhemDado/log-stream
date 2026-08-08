import { describe, expect, it } from "vitest";

import { loadDatabaseConfig } from "../../src/database/database-config.js";

describe("loadDatabaseConfig", () => {
  it("uses zero-configuration Compose defaults", () => {
    expect(loadDatabaseConfig({})).toEqual({
      connectionString:
        "postgresql://logstream_runtime:local_runtime_password@postgres:5432/logstream",
      maxConnections: 4,
      connectionTimeoutMs: 2_000,
      startupTimeoutMs: 30_000,
      retryDelayMs: 500,
    });
  });

  it("parses supported database settings", () => {
    expect(
      loadDatabaseConfig({
        DATABASE_URL: "postgresql://runtime:password@database:5432/logs",
        DB_POOL_MAX: "6",
        DB_CONNECTION_TIMEOUT_MS: "1500",
        DB_STARTUP_TIMEOUT_MS: "45000",
        DB_RETRY_DELAY_MS: "250",
      }),
    ).toEqual({
      connectionString: "postgresql://runtime:password@database:5432/logs",
      maxConnections: 6,
      connectionTimeoutMs: 1_500,
      startupTimeoutMs: 45_000,
      retryDelayMs: 250,
    });
  });

  it.each([
    ["DB_POOL_MAX", "0"],
    ["DB_POOL_MAX", "4workers"],
    ["DB_CONNECTION_TIMEOUT_MS", "0"],
    ["DB_STARTUP_TIMEOUT_MS", "forever"],
    ["DB_RETRY_DELAY_MS", "-1"],
  ])("rejects malformed %s configuration", (name, value) => {
    expect(() => loadDatabaseConfig({ [name]: value })).toThrow(`${name} must be`);
  });

  it("rejects retry delays beyond the startup deadline", () => {
    expect(() =>
      loadDatabaseConfig({ DB_STARTUP_TIMEOUT_MS: "100", DB_RETRY_DELAY_MS: "101" }),
    ).toThrow("DB_RETRY_DELAY_MS must not exceed DB_STARTUP_TIMEOUT_MS.");
  });

  it("rejects an invalid database URL without echoing credentials", () => {
    const secret = "private-password";

    expect(() => loadDatabaseConfig({ DATABASE_URL: secret })).toThrow(
      "DATABASE_URL must be a valid PostgreSQL URL.",
    );

    try {
      loadDatabaseConfig({ DATABASE_URL: secret });
    } catch (error: unknown) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
