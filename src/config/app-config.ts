const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8080;
const DEFAULT_LOG_LEVEL = "info";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHost(value: unknown): string {
  if (value === undefined) {
    return DEFAULT_HOST;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("HOST must be a non-empty string.");
  }

  return value.trim();
}

function parsePort(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }

  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error("PORT must be a base-10 integer between 1 and 65535.");
  }

  const port = Number(value);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a base-10 integer between 1 and 65535.");
  }

  return port;
}

function isLogLevel(value: string): value is LogLevel {
  return LOG_LEVELS.some((level) => level === value);
}

function parseLogLevel(value: unknown): LogLevel {
  if (value === undefined) {
    return DEFAULT_LOG_LEVEL;
  }

  if (typeof value !== "string" || !isLogLevel(value)) {
    throw new Error(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}.`);
  }

  return value;
}

export function loadConfig(environment: unknown): AppConfig {
  if (!isRecord(environment)) {
    throw new Error("Application environment must be an object.");
  }

  return {
    host: parseHost(environment["HOST"]),
    port: parsePort(environment["PORT"]),
    logLevel: parseLogLevel(environment["LOG_LEVEL"]),
  };
}
