import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { InternalDatabaseError } from "../../src/database/database-errors.js";
import type { LogId, LogInsertionRecord } from "../../src/domain/log-entry.js";
import type { IngestionRepository } from "../../src/modules/ingestion/ingestion-repository.js";
import { createIngestionService } from "../../src/modules/ingestion/ingestion-service.js";
import { TransientServiceError } from "../../src/shared/app-error.js";

const REFERENCE_TIME_MS = Date.UTC(2026, 7, 9, 12, 0, 0, 0);
const VALID_TIMESTAMP = "2026-08-09T11:00:00.000Z";
const JSON_HEADERS = { "content-type": "application/json" } as const;

interface HttpHarnessOptions {
  readonly insert?: (records: readonly LogInsertionRecord[]) => Promise<void>;
  readonly generateId?: () => LogId;
}

function logId(sequence: number): LogId {
  return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}` as LogId;
}

function validLog(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    timestamp: VALID_TIMESTAMP,
    level: "info",
    service: "checkout",
    message: "payment accepted",
    ...overrides,
  };
}

function createHttpHarness(options: HttpHarnessOptions = {}) {
  const calls: LogInsertionRecord[][] = [];
  let idSequence = 0;
  const repository: IngestionRepository = {
    insert: async (records) => {
      calls.push([...records]);
      await options.insert?.(records);
    },
  };
  const ingestionService = createIngestionService({
    repository,
    clock: () => REFERENCE_TIME_MS,
    generateId:
      options.generateId ??
      (() => {
        idSequence += 1;
        return logId(idSequence);
      }),
  });

  return {
    app: buildApp({ ingestionService }),
    calls,
  };
}

describe("POST /logs", () => {
  const apps: ReturnType<typeof buildApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it("accepts a one-entry batch after persistence resolves", async () => {
    const { app, calls } = createHttpHarness();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      payload: { logs: [validLog()] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 1, rejected: [] });
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
  });

  it("accepts an all-valid multi-entry batch with one repository call", async () => {
    const { app, calls } = createHttpHarness();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: [validLog({ service: "first" }), validLog({ service: "second" })],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 2, rejected: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.map((record) => record.service)).toEqual(["first", "second"]);
  });

  it("partially accepts a mixed batch and returns original rejection indexes", async () => {
    const { app, calls } = createHttpHarness();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: [
          validLog({ service: "first" }),
          validLog({ level: "critical" }),
          null,
          validLog({ service: "second" }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accepted: 2,
      rejected: [
        { index: 1, reason: "level must be one of debug, info, warn, or error" },
        { index: 2, reason: "log entry must be a non-null object" },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.map((record) => record.service)).toEqual(["first", "second"]);
  });

  it("returns the batch response with 400 when every entry is rejected", async () => {
    const { app, calls } = createHttpHarness();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      payload: { logs: [validLog({ service: "" }), 7] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      accepted: 0,
      rejected: [
        { index: 0, reason: "service must be non-empty" },
        { index: 1, reason: "log entry must be a non-null object" },
      ],
    });
    expect(calls).toEqual([]);
  });

  it("returns the approved empty-batch response without persistence", async () => {
    const { app, calls } = createHttpHarness();
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/logs", payload: { logs: [] } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ accepted: 0, rejected: [] });
    expect(calls).toEqual([]);
  });

  it.each([
    { name: "missing body", payload: undefined },
    { name: "null", payload: "null" },
    { name: "array", payload: "[]" },
    { name: "string", payload: '"logs"' },
    { name: "number", payload: "42" },
    { name: "missing logs", payload: "{}" },
    { name: "logs null", payload: '{"logs":null}' },
    { name: "logs object", payload: '{"logs":{}}' },
    { name: "logs string", payload: '{"logs":"entry"}' },
    { name: "bare entry", payload: JSON.stringify(validLog()) },
  ])("returns the approved top-level 400 envelope for $name", async ({ payload }) => {
    const { app, calls } = createHttpHarness();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      ...(payload === undefined ? {} : { headers: JSON_HEADERS, payload }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('{"error":"Invalid ingestion request."}');
    expect(calls).toEqual([]);
  });

  it("returns the centralized malformed-JSON response", async () => {
    const { app, calls } = createHttpHarness();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      headers: JSON_HEADERS,
      payload: '{"logs":[',
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('{"error":"Malformed JSON request body."}');
    expect(calls).toEqual([]);
  });

  it("ignores unknown top-level and entry fields while preserving ordinary Unicode and whitespace", async () => {
    const { app, calls } = createHttpHarness();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        metadata: { ignored: true },
        logs: [
          validLog({
            service: " שירות ",
            message: "  הודעה  ",
            unknown: { ignored: true },
          }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(calls[0]?.[0]?.service).toBe(" שירות ");
    expect(calls[0]?.[0]?.message).toBe("  הודעה  ");
    expect(Object.hasOwn(calls[0]?.[0] ?? {}, "unknown")).toBe(false);
    expect(Object.hasOwn(calls[0]?.[0] ?? {}, "metadata")).toBe(false);
  });

  it("rejects U+0000 per entry while committing the ordinary mixed-batch entry", async () => {
    const { app, calls } = createHttpHarness();
    apps.push(app);
    const payload = `{"logs":[${JSON.stringify(validLog({ service: "unsafe\u0000service" }))},${JSON.stringify(validLog({ service: "ordinary" }))}]}`;

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      headers: JSON_HEADERS,
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accepted: 1,
      rejected: [{ index: 0, reason: "service must not contain U+0000" }],
    });
    expect(calls[0]?.map((record) => record.service)).toEqual(["ordinary"]);
  });

  it("accepts and preserves scalar __proto__ and constructor attribute keys from raw JSON", async () => {
    const { app, calls } = createHttpHarness();
    apps.push(app);
    const payload = `{"logs":[{"timestamp":"${VALID_TIMESTAMP}","level":"info","service":"checkout","message":"safe","attributes":{"__proto__":"prototype-value","constructor":"constructor-value"}}]}`;

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      headers: JSON_HEADERS,
      payload,
    });

    expect(response.statusCode).toBe(200);
    const attributes = calls[0]?.[0]?.attributes;
    expect(Object.getPrototypeOf(attributes)).toBeNull();
    expect(attributes?.["__proto__"]).toBe("prototype-value");
    expect(Reflect.get(attributes ?? {}, "constructor")).toBe("constructor-value");
    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();
  });

  it("ignores unknown prototype-sensitive fields without polluting prototypes", async () => {
    const { app, calls } = createHttpHarness();
    apps.push(app);
    const payload = `{"__proto__":{"polluted":"top"},"constructor":{"prototype":{"polluted":"top-constructor"}},"logs":[{"timestamp":"${VALID_TIMESTAMP}","level":"info","service":"checkout","message":"safe","__proto__":{"polluted":"entry"},"constructor":{"prototype":{"polluted":"entry-constructor"}}}]}`;

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      headers: JSON_HEADERS,
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 1, rejected: [] });
    expect(Object.hasOwn(calls[0]?.[0] ?? {}, "__proto__")).toBe(false);
    expect(Object.hasOwn(calls[0]?.[0] ?? {}, "constructor")).toBe(false);
    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();
  });

  it("rejects nested prototype-sensitive attribute values without prototype pollution", async () => {
    const { app, calls } = createHttpHarness();
    apps.push(app);
    const payload = `{"logs":[{"timestamp":"${VALID_TIMESTAMP}","level":"info","service":"checkout","message":"safe","attributes":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}}]}`;

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      headers: JSON_HEADERS,
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      accepted: 0,
      rejected: [
        { index: 0, reason: "attribute values must be strings, finite numbers, or booleans" },
      ],
    });
    expect(calls).toEqual([]);
    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();
  });

  it("uses Fastify's JSON.parse-compatible last value for duplicate object keys", async () => {
    const { app, calls } = createHttpHarness();
    apps.push(app);
    const payload = `{"logs":[{"timestamp":"${VALID_TIMESTAMP}","level":"info","service":"first","service":"last","message":"safe"}]}`;

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      headers: JSON_HEADERS,
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(calls[0]?.[0]?.service).toBe("last");
  });

  it("maps a transient repository failure to generic 503 with Retry-After", async () => {
    const secret = "postgresql://runtime:secret@database/logstream";
    const { app } = createHttpHarness({
      insert: () => {
        const error = new TransientServiceError();
        Object.defineProperty(error, "hidden", { value: secret });
        return Promise.reject(error);
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      payload: { logs: [validLog({ service: "submitted-secret" })] },
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{"error":"Service temporarily unavailable."}');
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain("submitted-secret");
    expect(response.body).not.toContain("accepted");
  });

  it("maps an internal repository failure to generic 500 without false success", async () => {
    const { app } = createHttpHarness({
      insert: () => Promise.reject(new InternalDatabaseError()),
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      payload: { logs: [validLog({ service: "submitted-secret" })] },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('{"error":"Internal server error."}');
    expect(response.body).not.toContain("Database operation failed");
    expect(response.body).not.toContain("submitted-secret");
    expect(response.body).not.toContain("accepted");
  });
});
