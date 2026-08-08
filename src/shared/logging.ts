import type { FastifyServerOptions } from "fastify";

import type { AppConfig } from "../config/app-config.js";

const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "databaseUrl",
  "*.databaseUrl",
  "connectionString",
  "*.connectionString",
  "migrationConnectionString",
  "*.migrationConnectionString",
  "password",
  "*.password",
  "token",
  "*.token",
] as const;

export function buildLoggerOptions(config: AppConfig): FastifyServerOptions["logger"] {
  return {
    level: config.logLevel,
    redact: {
      paths: [...REDACTED_PATHS],
      censor: "[REDACTED]",
    },
  };
}
