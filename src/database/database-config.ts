const DEFAULT_DATABASE_URL =
  "postgresql://logstream_runtime:local_runtime_password@postgres:5432/logstream";
const DEFAULT_POOL_MAX = 4;
const DEFAULT_CONNECTION_TIMEOUT_MS = 2_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 500;

export interface DatabaseConfig {
  readonly connectionString: string;
  readonly maxConnections: number;
  readonly connectionTimeoutMs: number;
  readonly startupTimeoutMs: number;
  readonly retryDelayMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDatabaseUrl(value: unknown): string {
  if (value === undefined) {
    return DEFAULT_DATABASE_URL;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }

  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
      parsed.hostname.length === 0 ||
      parsed.username.length === 0
    ) {
      throw new Error("invalid PostgreSQL URL");
    }
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }

  return value;
}

function parseBoundedInteger(
  value: unknown,
  name: string,
  defaultValue: number,
  maximum: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a base-10 integer between 1 and ${String(maximum)}.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be a base-10 integer between 1 and ${String(maximum)}.`);
  }

  return parsed;
}

export function loadDatabaseConfig(environment: unknown): DatabaseConfig {
  if (!isRecord(environment)) {
    throw new Error("Database environment must be an object.");
  }

  const startupTimeoutMs = parseBoundedInteger(
    environment["DB_STARTUP_TIMEOUT_MS"],
    "DB_STARTUP_TIMEOUT_MS",
    DEFAULT_STARTUP_TIMEOUT_MS,
    300_000,
  );
  const retryDelayMs = parseBoundedInteger(
    environment["DB_RETRY_DELAY_MS"],
    "DB_RETRY_DELAY_MS",
    DEFAULT_RETRY_DELAY_MS,
    30_000,
  );

  if (retryDelayMs > startupTimeoutMs) {
    throw new Error("DB_RETRY_DELAY_MS must not exceed DB_STARTUP_TIMEOUT_MS.");
  }

  return {
    connectionString: parseDatabaseUrl(environment["DATABASE_URL"]),
    maxConnections: parseBoundedInteger(
      environment["DB_POOL_MAX"],
      "DB_POOL_MAX",
      DEFAULT_POOL_MAX,
      32,
    ),
    connectionTimeoutMs: parseBoundedInteger(
      environment["DB_CONNECTION_TIMEOUT_MS"],
      "DB_CONNECTION_TIMEOUT_MS",
      DEFAULT_CONNECTION_TIMEOUT_MS,
      60_000,
    ),
    startupTimeoutMs,
    retryDelayMs,
  };
}
