import { describe, expect, it } from "vitest";

import { InternalDatabaseError } from "../../src/database/database-errors.js";
import type { LogId, LogInsertionRecord } from "../../src/domain/log-entry.js";
import type { IngestionRepository } from "../../src/modules/ingestion/ingestion-repository.js";
import {
  createIngestionService,
  type IngestionService,
} from "../../src/modules/ingestion/ingestion-service.js";
import { BadRequestError, TransientServiceError } from "../../src/shared/app-error.js";

const REFERENCE_TIME_MS = Date.UTC(2026, 7, 9, 12, 0, 0, 0);
const VALID_TIMESTAMP = "2026-08-09T11:00:00.000Z";
const NUL = "\u0000";

interface ServiceHarnessOptions {
  readonly clock?: () => number;
  readonly generateId?: () => LogId;
  readonly insert?: (records: readonly LogInsertionRecord[]) => Promise<void>;
}

interface ServiceHarness {
  readonly service: IngestionService;
  readonly calls: LogInsertionRecord[][];
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

function createHarness(options: ServiceHarnessOptions = {}): ServiceHarness {
  const calls: LogInsertionRecord[][] = [];
  let idSequence = 0;
  const repository: IngestionRepository = {
    insert: async (records) => {
      calls.push([...records]);
      await options.insert?.(records);
    },
  };

  return {
    calls,
    service: createIngestionService({
      repository,
      clock: options.clock ?? (() => REFERENCE_TIME_MS),
      generateId:
        options.generateId ??
        (() => {
          idSequence += 1;
          return logId(idSequence);
        }),
    }),
  };
}

describe("createIngestionService", () => {
  it.each([
    { name: "undefined", body: undefined },
    { name: "null", body: null },
    { name: "array", body: [] },
    { name: "string", body: "logs" },
    { name: "number", body: 42 },
    { name: "missing logs", body: {} },
    { name: "null logs", body: { logs: null } },
    { name: "object logs", body: { logs: {} } },
    { name: "string logs", body: { logs: "entry" } },
    { name: "bare log", body: validLog() },
    { name: "inherited logs", body: Object.create({ logs: [] }) as object },
  ])("rejects an invalid top-level body: $name", async ({ body }) => {
    const { service, calls } = createHarness();

    const operation = service.ingest(body);

    await expect(operation).rejects.toBeInstanceOf(BadRequestError);
    await expect(operation).rejects.toMatchObject({
      statusCode: 400,
      publicMessage: "Invalid ingestion request.",
    });
    expect(calls).toEqual([]);
  });

  it("treats an empty logs array as a valid zero-acceptance batch", async () => {
    let clockCalls = 0;
    const { service, calls } = createHarness({
      clock: () => {
        clockCalls += 1;
        return REFERENCE_TIME_MS;
      },
    });

    await expect(service.ingest({ logs: [] })).resolves.toEqual({ accepted: 0, rejected: [] });
    expect(clockCalls).toBe(1);
    expect(calls).toEqual([]);
  });

  it("normalizes and inserts one valid entry", async () => {
    const expectedId = logId(1);
    const { service, calls } = createHarness({ generateId: () => expectedId });

    const response = await service.ingest({
      logs: [
        validLog({
          attributes: { text: "42", count: 42, enabled: true, disabled: false },
        }),
      ],
    });

    expect(response).toEqual({ accepted: 1, rejected: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(calls[0]?.[0]).toMatchObject({
      id: expectedId,
      timestamp: VALID_TIMESTAMP,
      level: "info",
      service: "checkout",
      message: "payment accepted",
      attributes: { text: "42", count: 42, enabled: true, disabled: false },
    });
  });

  it("partitions a mixed batch while preserving accepted order and rejection indexes", async () => {
    const generatedIds = [logId(10), logId(11)];
    let idIndex = 0;
    let clockCalls = 0;
    const { service, calls } = createHarness({
      clock: () => {
        clockCalls += 1;
        return REFERENCE_TIME_MS;
      },
      generateId: () => generatedIds[idIndex++] ?? logId(99),
    });

    const response = await service.ingest({
      logs: [
        null,
        validLog({ service: "first-valid" }),
        validLog({ message: "" }),
        validLog({ service: "second-valid" }),
        validLog({ attributes: { nested: { unsafe: true } } }),
      ],
    });

    expect(response).toEqual({
      accepted: 2,
      rejected: [
        { index: 0, reason: "log entry must be a non-null object" },
        { index: 2, reason: "message must be non-empty" },
        { index: 4, reason: "attribute values must be strings, finite numbers, or booleans" },
      ],
    });
    expect(clockCalls).toBe(1);
    expect(idIndex).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.map((record) => record.id)).toEqual(generatedIds);
    expect(calls[0]?.map((record) => record.service)).toEqual(["first-valid", "second-valid"]);
  });

  it("does not generate IDs or call the repository when all entries are invalid", async () => {
    let idCalls = 0;
    const { service, calls } = createHarness({
      generateId: () => {
        idCalls += 1;
        return logId(idCalls);
      },
    });

    const response = await service.ingest({
      logs: [validLog({ service: "" }), 7, validLog({ attributes: null })],
    });

    expect(response).toEqual({
      accepted: 0,
      rejected: [
        { index: 0, reason: "service must be non-empty" },
        { index: 1, reason: "log entry must be a non-null object" },
        { index: 2, reason: "attributes must be a non-null object" },
      ],
    });
    expect(idCalls).toBe(0);
    expect(calls).toEqual([]);
  });

  it("rejects U+0000 per entry without preventing an ordinary entry from reaching persistence", async () => {
    const { service, calls } = createHarness();

    const response = await service.ingest({
      logs: [
        validLog({ service: `unsafe${NUL}service` }),
        validLog({ service: "ordinary" }),
        validLog({ attributes: { request_id: `unsafe${NUL}value` } }),
      ],
    });

    expect(response).toEqual({
      accepted: 1,
      rejected: [
        { index: 0, reason: "service must not contain U+0000" },
        { index: 2, reason: "string attribute values must not contain U+0000" },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.map((record) => record.service)).toEqual(["ordinary"]);
  });

  it("ignores unknown body and entry fields instead of forwarding them", async () => {
    const { service, calls } = createHarness();

    const response = await service.ingest({
      metadata: { hostile: true },
      logs: [validLog({ extra: "ignored", configuration: { admin: true } })],
    });

    expect(response).toEqual({ accepted: 1, rejected: [] });
    const stored = calls[0]?.[0] as LogInsertionRecord & Record<string, unknown>;
    expect(Object.hasOwn(stored, "extra")).toBe(false);
    expect(Object.hasOwn(stored, "configuration")).toBe(false);
    expect(Object.hasOwn(stored, "metadata")).toBe(false);
  });

  it("preserves prototype-sensitive attribute keys through safe copied records", async () => {
    const attributes = JSON.parse(
      '{"":"empty","שלום":"unicode","__proto__":"prototype","constructor":"constructor"}',
    ) as Record<string, unknown>;
    const { service, calls } = createHarness();

    await service.ingest({ logs: [validLog({ attributes })] });

    const record = calls[0]?.[0];
    expect(Object.getPrototypeOf(record?.attributes)).toBeNull();
    expect(record?.attributes[""]).toBe("empty");
    expect(record?.attributes["שלום"]).toBe("unicode");
    expect(record?.attributes["__proto__"]).toBe("prototype");
    expect(Reflect.get(record?.attributes ?? {}, "constructor")).toBe("constructor");
  });

  it("does not mutate accepted caller-owned objects", async () => {
    const attributes = Object.freeze({ request_id: "abc", retries: 3 });
    const entry = Object.freeze(validLog({ attributes, unknown: "ignored" }));
    const body = Object.freeze({ logs: Object.freeze([entry]) });
    const { service } = createHarness();

    await expect(service.ingest(body)).resolves.toEqual({ accepted: 1, rejected: [] });
    expect(body.logs[0]).toBe(entry);
    expect(entry["attributes"]).toBe(attributes);
    expect(attributes).toEqual({ request_id: "abc", retries: 3 });
  });

  it("does not resolve a successful response before the repository resolves", async () => {
    let releaseInsert: (() => void) | undefined;
    const insertBlocked = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    const { service } = createHarness({ insert: async () => insertBlocked });
    let responseSettled = false;

    const responsePromise = service.ingest({ logs: [validLog()] }).then((response) => {
      responseSettled = true;
      return response;
    });
    await Promise.resolve();

    expect(responseSettled).toBe(false);
    releaseInsert?.();
    await expect(responsePromise).resolves.toEqual({ accepted: 1, rejected: [] });
  });

  it.each([
    { name: "internal", error: new InternalDatabaseError() },
    { name: "transient", error: new TransientServiceError() },
  ])("propagates an $name repository failure without returning success", async ({ error }) => {
    const { service, calls } = createHarness({
      insert: () => Promise.reject(error),
    });

    await expect(service.ingest({ logs: [validLog()] })).rejects.toBe(error);
    expect(calls).toHaveLength(1);
  });
});
