import { describe, expect, it } from "vitest";

import { loadDatabaseConfig } from "../../src/database/database-config.js";

describe("loadDatabaseConfig", () => {
  it("uses zero-configuration Compose defaults", () => {
    expect(loadDatabaseConfig({})).toEqual({
      connectionString:
        "postgresql://logstream_runtime:local_runtime_password@postgres:5432/logstream",
      migrationConnectionString:
        "postgresql://logstream_owner:local_owner_password@postgres:5432/logstream",
      maxConnections: 4,
      connectionTimeoutMs: 10_000,
      queryTimeoutMs: 10_000,
      startupTimeoutMs: 30_000,
      retryDelayMs: 500,
      retentionDays: 30,
      retentionIntervalMs: 3_600_000,
    });
  });

  it("parses supported database settings", () => {
    expect(
      loadDatabaseConfig({
        DATABASE_URL: "postgresql://runtime:password@database:5432/logs",
        MIGRATION_DATABASE_URL: "postgresql://owner:password@database:5432/logs",
        DB_POOL_MAX: "6",
        DB_CONNECTION_TIMEOUT_MS: "1500",
        DB_QUERY_TIMEOUT_MS: "12000",
        DB_STARTUP_TIMEOUT_MS: "45000",
        DB_RETRY_DELAY_MS: "250",
        RETENTION_DAYS: "90",
        RETENTION_INTERVAL_MINUTES: "15",
      }),
    ).toEqual({
      connectionString: "postgresql://runtime:password@database:5432/logs",
      migrationConnectionString: "postgresql://owner:password@database:5432/logs",
      maxConnections: 6,
      connectionTimeoutMs: 1_500,
      queryTimeoutMs: 12_000,
      startupTimeoutMs: 45_000,
      retryDelayMs: 250,
      retentionDays: 90,
      retentionIntervalMs: 900_000,
    });
  });

  it.each([
    ["DB_POOL_MAX", "0"],
    ["DB_POOL_MAX", "4workers"],
    ["DB_CONNECTION_TIMEOUT_MS", "0"],
    ["DB_QUERY_TIMEOUT_MS", "120001"],
    ["DB_STARTUP_TIMEOUT_MS", "forever"],
    ["DB_RETRY_DELAY_MS", "-1"],
    ["RETENTION_DAYS", "0"],
    ["RETENTION_DAYS", "3651"],
    ["RETENTION_INTERVAL_MINUTES", "0"],
    ["RETENTION_INTERVAL_MINUTES", "1441"],
    ["RETENTION_INTERVAL_MINUTES", "+1"],
    ["RETENTION_INTERVAL_MINUTES", "1.5"],
    ["RETENTION_INTERVAL_MINUTES", " 1"],
    ["RETENTION_INTERVAL_MINUTES", "1 "],
    ["RETENTION_INTERVAL_MINUTES", "1minute"],
    ["RETENTION_INTERVAL_MINUTES", "9007199254740992"],
  ])("rejects malformed %s configuration", (name, value) => {
    expect(() => loadDatabaseConfig({ [name]: value })).toThrow(`${name} must be`);
  });

  it.each([
    ["minimum", "1", 60_000],
    ["maximum", "1440", 86_400_000],
  ])("converts the %s retention interval to safe milliseconds", (_name, value, expected) => {
    expect(loadDatabaseConfig({ RETENTION_INTERVAL_MINUTES: value }).retentionIntervalMs).toBe(
      expected,
    );
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

  it("rejects an invalid migration URL without echoing credentials", () => {
    const secret = "private-owner-password";

    expect(() => loadDatabaseConfig({ MIGRATION_DATABASE_URL: secret })).toThrow(
      "MIGRATION_DATABASE_URL must be a valid PostgreSQL URL.",
    );

    try {
      loadDatabaseConfig({ MIGRATION_DATABASE_URL: secret });
    } catch (error: unknown) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
