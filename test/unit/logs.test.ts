import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { InternalDatabaseError } from "../../src/database/database-errors.js";
import type {
  ApiLogResponseItem,
  CanonicalUtcTimestamp,
  LogId,
  LogInsertionRecord,
} from "../../src/domain/log-entry.js";
import type { IngestionRepository } from "../../src/modules/ingestion/ingestion-repository.js";
import { createIngestionService } from "../../src/modules/ingestion/ingestion-service.js";
import type {
  LogQueryPageRequest,
  LogQueryRepository,
} from "../../src/modules/query/log-query-repository.js";
import { encodeLogCursor } from "../../src/modules/query/cursor-codec.js";
import {
  createLogQueryService,
  type LogQueryService,
} from "../../src/modules/query/log-query-service.js";
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

function queryLog(sequence = 1): ApiLogResponseItem {
  return {
    id: logId(sequence),
    timestamp: VALID_TIMESTAMP as CanonicalUtcTimestamp,
    level: "info",
    service: "checkout",
    message: "payment accepted",
    attributes: {} as ApiLogResponseItem["attributes"],
  };
}

function createQueryHttpHarness(
  implementation: (request: LogQueryPageRequest) => Promise<readonly ApiLogResponseItem[]> = () =>
    Promise.resolve([]),
) {
  const findPage = vi.fn(implementation);
  const repository: LogQueryRepository = { findPage };
  const logQueryService = createLogQueryService({ repository });

  return { app: buildApp({ logQueryService }), findPage, logQueryService };
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

describe("GET /logs", () => {
  const apps: ReturnType<typeof buildApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  it("returns the exact successful query response with HTTP 200", async () => {
    const item = queryLog();
    const { app, findPage } = createQueryHttpHarness(() => Promise.resolve([item]));
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/logs?service=checkout&limit=2" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ logs: [item], next_cursor: null });
    expect(findPage).toHaveBeenCalledWith({
      filters: { attributes: [], service: "checkout" },
      limit: 2,
    });
  });

  it("passes Fastify's raw query object unchanged to an injected query service", async () => {
    const list = vi.fn<LogQueryService["list"]>(() =>
      Promise.resolve({ logs: [], next_cursor: null }),
    );
    const logQueryService: LogQueryService = { list };
    const app = buildApp({ logQueryService });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/logs?service=checkout&service=auth&metadata=ignored",
    });

    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledOnce();
    expect(list.mock.calls[0]?.[0]).toEqual({
      service: ["checkout", "auth"],
      metadata: "ignored",
    });
  });

  it("registers GET and POST independently and together", async () => {
    const queryOnly = createQueryHttpHarness().app;
    const ingestionOnly = createHttpHarness().app;
    const ingestionService = createIngestionService({
      repository: { insert: () => Promise.resolve() },
      clock: () => REFERENCE_TIME_MS,
      generateId: () => logId(1),
    });
    const logQueryService: LogQueryService = {
      list: () => Promise.resolve({ logs: [], next_cursor: null }),
    };
    const both = buildApp({ ingestionService, logQueryService });
    apps.push(queryOnly, ingestionOnly, both);

    expect((await queryOnly.inject({ method: "GET", url: "/logs" })).statusCode).toBe(200);
    expect(
      (await queryOnly.inject({ method: "POST", url: "/logs", payload: { logs: [] } })).statusCode,
    ).toBe(404);
    expect((await ingestionOnly.inject({ method: "GET", url: "/logs" })).statusCode).toBe(404);
    expect(
      (await ingestionOnly.inject({ method: "POST", url: "/logs", payload: { logs: [] } }))
        .statusCode,
    ).toBe(400);
    expect((await both.inject({ method: "GET", url: "/logs" })).statusCode).toBe(200);
    expect(
      (await both.inject({ method: "POST", url: "/logs", payload: { logs: [] } })).statusCode,
    ).toBe(400);
  });

  it("returns QRY-004 HTTP 400 and never calls the repository when until is earlier", async () => {
    const { app, findPage } = createQueryHttpHarness();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/logs?since=2026-08-09T12%3A00%3A00.000Z&until=2026-08-09T11%3A59%3A59.999Z",
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(
      "{\"error\":\"Query parameter 'until' must not be earlier than 'since'.\"}",
    );
    expect(findPage).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "duplicate scalar",
      url: "/logs?service=checkout&service=checkout",
      body: '{"error":"Query parameter \'service\' must appear at most once."}',
    },
    {
      name: "malformed cursor",
      url: "/logs?cursor=not-a-valid-cursor",
      body: '{"error":"Query parameter \'cursor\' is invalid."}',
    },
    {
      name: "PostgreSQL-incompatible NUL",
      url: "/logs?service=unsafe%00service",
      body: '{"error":"Query parameter \'service\' must not contain U+0000."}',
    },
  ])("returns the fixed HTTP 400 envelope for $name before querying", async ({ url, body }) => {
    const { app, findPage } = createQueryHttpHarness();
    apps.push(app);

    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(body);
    expect(findPage).not.toHaveBeenCalled();
  });

  it("rejects a structurally valid cursor bound to different normalized filters", async () => {
    const cursorSourceFilter = "cursor-source";
    const submittedFilter = "cursor-target";
    const token = encodeLogCursor(
      {
        timestamp: VALID_TIMESTAMP as CanonicalUtcTimestamp,
        id: logId(9),
      },
      { attributes: [], service: cursorSourceFilter },
    );
    const { app, findPage } = createQueryHttpHarness();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/logs?service=${submittedFilter}&cursor=${encodeURIComponent(token)}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('{"error":"Query parameter \'cursor\' is invalid."}');
    expect(findPage).not.toHaveBeenCalled();
    for (const sensitiveText of [
      token,
      cursorSourceFilter,
      submittedFilter,
      "filterFingerprint",
      "SELECT",
      "logstream.logs",
      "postgresql://",
    ]) {
      expect(response.body).not.toContain(sensitiveText);
    }
  });

  it("ignores unknown query parameters while preserving recognized filters", async () => {
    const { app, findPage } = createQueryHttpHarness();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/logs?metadata=one&metadata=two&servce=ignored&service=checkout",
    });

    expect(response.statusCode).toBe(200);
    expect(findPage).toHaveBeenCalledWith({
      filters: { attributes: [], service: "checkout" },
      limit: 100,
    });
  });

  it("maps a transient query failure to generic 503 with Retry-After", async () => {
    const secret = "postgresql://runtime:secret@database/logstream";
    const { app } = createQueryHttpHarness(() => {
      const error = new TransientServiceError();
      Object.defineProperty(error, "hidden", { value: secret });
      return Promise.reject(error);
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/logs?service=submitted-secret" });

    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{"error":"Service temporarily unavailable."}');
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain("submitted-secret");
    expect(response.body).not.toContain("logs");
  });

  it("maps an internal query failure to generic 500 without a success body", async () => {
    const { app } = createQueryHttpHarness(() => Promise.reject(new InternalDatabaseError()));
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/logs?q=submitted-secret" });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('{"error":"Internal server error."}');
    expect(response.body).not.toContain("Database operation failed");
    expect(response.body).not.toContain("submitted-secret");
    expect(response.body).not.toContain("next_cursor");
  });
});
