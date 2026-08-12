import { describe, expect, it } from "vitest";

import { buildLoggerOptions } from "../../src/shared/logging.js";

describe("buildLoggerOptions", () => {
  it("redacts complete request URLs and every existing sensitive path with the fixed censor", () => {
    const options = buildLoggerOptions({ host: "0.0.0.0", port: 8080, logLevel: "info" });

    expect(options).toEqual({
      level: "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.url",
          "request.headers.authorization",
          "request.headers.cookie",
          "request.url",
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
        ],
        censor: "[REDACTED]",
      },
    });
  });
});
