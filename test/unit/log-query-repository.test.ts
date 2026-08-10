import { describe, expect, it, vi } from "vitest";

import { InternalDatabaseError } from "../../src/database/database-errors.js";
import type {
  ApiLogResponseItem,
  CanonicalUtcTimestamp,
  LogId,
} from "../../src/domain/log-entry.js";
import type { LogCursorPosition } from "../../src/modules/query/cursor-codec.js";
import {
  createLogQueryRepository,
  type LogQueryDatabasePool,
} from "../../src/modules/query/log-query-repository.js";
import type { LogFilters } from "../../src/modules/query/query-parameter-parser.js";
import { TransientServiceError } from "../../src/shared/app-error.js";

const TIMESTAMP = "2026-08-09T11:00:00.123456Z" as CanonicalUtcTimestamp;
const ID = "00000000-0000-4000-8000-000000000010" as LogId;

function filters(overrides: Partial<LogFilters> = {}): LogFilters {
  return { attributes: [], ...overrides };
}

function cursor(overrides: Partial<LogCursorPosition> = {}): LogCursorPosition {
  return { timestamp: TIMESTAMP, id: ID, ...overrides };
}

function databaseRow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: ID,
    timestamp: TIMESTAMP,
    level: "error",
    service: "checkout",
    message: "payment declined",
    attributes: {},
    ...overrides,
  };
}

function databaseDouble(rows: readonly unknown[] = [databaseRow()]) {
  const query = vi.fn(() => Promise.resolve({ rows }));
  const pool: LogQueryDatabasePool = { query };
  return { pool, query };
}

function firstQueryCall(query: ReturnType<typeof vi.fn>): [string, unknown[]] {
  const call = query.mock.calls[0];
  if (call === undefined || !Array.isArray(call[1])) {
    throw new Error("Expected one parameterized query call.");
  }

  return [String(call[0]), call[1] as unknown[]];
}

describe("log query repository SQL", () => {
  it.each([
    { limit: 1, fetched: 2 },
    { limit: 1_000, fetched: 1_001 },
  ])("executes one bounded query for client limit $limit", async ({ limit, fetched }) => {
    const database = databaseDouble([]);
    const repository = createLogQueryRepository(database.pool);

    await expect(repository.findPage({ filters: filters(), limit })).resolves.toEqual([]);

    expect(database.query).toHaveBeenCalledOnce();
    const [sql, values] = firstQueryCall(database.query);
    expect(values).toEqual([fetched]);
    expect(sql).toContain("WHERE TRUE");
    expect(sql).toContain('ORDER BY logs."timestamp" DESC, logs.id DESC');
    expect(sql).toContain("LIMIT $1::integer");
    expect(sql).not.toMatch(/\bOFFSET\b/iu);
    expect(sql).not.toMatch(/\bCOUNT\s*\(/iu);
    expect(sql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/iu);
  });

  it("never returns more than the bounded lookahead size", async () => {
    const database = databaseDouble([databaseRow(), databaseRow(), databaseRow(), databaseRow()]);
    const repository = createLogQueryRepository(database.pool);

    const page = await repository.findPage({ filters: filters(), limit: 2 });

    expect(page).toHaveLength(3);
  });

  it("keeps predicate, cursor, and limit values in deterministic placeholder order", async () => {
    const database = databaseDouble([]);
    const repository = createLogQueryRepository(database.pool);
    const since = "2026-08-09T10:00:00.000Z" as CanonicalUtcTimestamp;
    const until = "2026-08-09T12:00:00.000Z" as CanonicalUtcTimestamp;
    const position = cursor();

    await repository.findPage({
      filters: filters({
        service: "checkout",
        level: "error",
        since,
        until,
        attributes: [
          { key: "enabled", value: "true" },
          { key: "retries", value: "3" },
        ],
        q: "Payment%_\\Declined",
      }),
      limit: 25,
      cursor: position,
    });

    const [sql, values] = firstQueryCall(database.query);
    expect(values).toEqual([
      "checkout",
      "error",
      since,
      until,
      '{"enabled":"true"}',
      '{"retries":"3"}',
      "%Payment\\%\\_\\\\Declined%",
      position.timestamp,
      position.id,
      26,
    ]);
    expect(sql).toContain("service = $1::text");
    expect(sql).toContain("level = $2::text");
    expect(sql).toContain('"timestamp" >= $3::timestamptz');
    expect(sql).toContain('"timestamp" < $4::timestamptz');
    expect(sql).toContain("attributes_search @> $5::jsonb");
    expect(sql).toContain("attributes_search @> $6::jsonb");
    expect(sql).toContain("message ILIKE $7::text ESCAPE E'\\\\'");
    expect(sql).toContain('AND (logs."timestamp", logs.id) < ($8::timestamptz, $9::uuid)');
    expect(sql).toContain("LIMIT $10::integer");
  });

  it("keeps hostile filter and cursor text out of fixed SQL structure", async () => {
    const database = databaseDouble([]);
    const repository = createLogQueryRepository(database.pool);
    const hostileService = "checkout'); DROP TABLE logstream.logs; --";
    const hostileAttribute = 'key"} OR TRUE --';
    const hostileValue = "value'); SELECT pg_sleep(10); --";
    const hostileQuery = "%_\\' UNION SELECT";

    await repository.findPage({
      filters: filters({
        service: hostileService,
        attributes: [{ key: hostileAttribute, value: hostileValue }],
        q: hostileQuery,
      }),
      limit: 2,
      cursor: cursor(),
    });

    const [sql, values] = firstQueryCall(database.query);
    for (const hostileText of [hostileService, hostileAttribute, hostileValue, hostileQuery, ID]) {
      expect(sql).not.toContain(hostileText);
    }
    expect(values[0]).toBe(hostileService);
    expect(JSON.parse(String(values[1]))).toEqual({ [hostileAttribute]: hostileValue });
  });

  it("projects lossless UTC text while ordering and continuing on the raw timestamp", async () => {
    const database = databaseDouble([]);
    const repository = createLogQueryRepository(database.pool);

    await repository.findPage({ filters: filters(), limit: 10, cursor: cursor() });

    const [sql] = firstQueryCall(database.query);
    expect(sql).toContain("logs.\"timestamp\" AT TIME ZONE 'UTC'");
    expect(sql).toContain('\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\'');
    expect(sql).toContain('ORDER BY logs."timestamp" DESC, logs.id DESC');
    expect(sql).toContain('(logs."timestamp", logs.id) <');
    expect(sql).not.toContain("ORDER BY timestamp DESC");
  });
});

describe("log query repository row mapping", () => {
  it("maps exact response fields, canonicalizes timestamp text, and safely copies attributes", async () => {
    const attributes = JSON.parse(
      '{"":"empty","__proto__":"prototype","constructor":"constructor","toString":"string key","count":3,"enabled":true}',
    ) as Record<string, unknown>;
    const database = databaseDouble([
      databaseRow({
        timestamp: "2026-08-09T11:00:00.123400Z",
        attributes,
        attributes_search: { secret: "not public" },
        created_at: "not public",
      }),
    ]);
    const repository = createLogQueryRepository(database.pool);

    const result = await repository.findPage({ filters: filters(), limit: 10 });

    expect(result).toHaveLength(1);
    const item = result[0] as ApiLogResponseItem & Record<string, unknown>;
    expect(Object.keys(item)).toEqual([
      "id",
      "timestamp",
      "level",
      "service",
      "message",
      "attributes",
    ]);
    expect(item.timestamp).toBe("2026-08-09T11:00:00.1234Z");
    expect(Object.getPrototypeOf(item.attributes)).toBeNull();
    expect(item.attributes[""]).toBe("empty");
    expect(item.attributes["__proto__"]).toBe("prototype");
    expect(Reflect.get(item.attributes, "constructor")).toBe("constructor");
    expect(Reflect.get(item.attributes, "toString")).toBe("string key");
    expect(item.attributes["count"]).toBe(3);
    expect(item.attributes["enabled"]).toBe(true);
    expect(Object.hasOwn(item, "attributes_search")).toBe(false);
    expect(Object.hasOwn(item, "created_at")).toBe(false);
    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();
  });

  it("returns a null-prototype empty object for stored empty attributes", async () => {
    const database = databaseDouble([databaseRow({ attributes: {} })]);
    const repository = createLogQueryRepository(database.pool);

    const result = await repository.findPage({ filters: filters(), limit: 1 });

    expect(result[0]?.attributes).toEqual({});
    expect(Object.getPrototypeOf(result[0]?.attributes)).toBeNull();
  });

  it.each([
    { name: "non-object row", row: null },
    { name: "invalid UUID", row: databaseRow({ id: "not-a-uuid" }) },
    {
      name: "non-v4 UUID",
      row: databaseRow({ id: "00000000-0000-1000-8000-000000000010" }),
    },
    { name: "invalid timestamp", row: databaseRow({ timestamp: "not-a-timestamp" }) },
    { name: "invalid level", row: databaseRow({ level: "critical" }) },
    { name: "non-string service", row: databaseRow({ service: 42 }) },
    { name: "non-string message", row: databaseRow({ message: null }) },
    { name: "missing attributes", row: databaseRow({ attributes: undefined }) },
    { name: "array attributes", row: databaseRow({ attributes: [] }) },
    { name: "nested attribute", row: databaseRow({ attributes: { nested: {} } }) },
    { name: "null attribute", row: databaseRow({ attributes: { value: null } }) },
    { name: "non-finite attribute", row: databaseRow({ attributes: { value: Infinity } }) },
  ])("rejects a malformed database boundary: $name", async ({ row }) => {
    const database = databaseDouble([row]);
    const repository = createLogQueryRepository(database.pool);

    await expect(repository.findPage({ filters: filters(), limit: 10 })).rejects.toBeInstanceOf(
      InternalDatabaseError,
    );
  });

  it("rejects accessor attributes without evaluating them or exposing their value", async () => {
    const attributes: Record<string, unknown> = {};
    Object.defineProperty(attributes, "secret", {
      enumerable: true,
      get: () => {
        throw new Error("submitted database secret");
      },
    });
    const database = databaseDouble([databaseRow({ attributes })]);
    const repository = createLogQueryRepository(database.pool);

    await expect(repository.findPage({ filters: filters(), limit: 10 })).rejects.toBeInstanceOf(
      InternalDatabaseError,
    );
  });
});

describe("log query repository error translation", () => {
  it("preserves transient classification without retaining the source", async () => {
    const source = Object.assign(new Error("postgresql://runtime:secret@database/logstream"), {
      code: "ECONNREFUSED",
    });
    const pool: LogQueryDatabasePool = { query: vi.fn(() => Promise.reject(source)) };
    const repository = createLogQueryRepository(pool);

    let thrown: unknown;
    try {
      await repository.findPage({ filters: filters(), limit: 10 });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TransientServiceError);
    expect(String(thrown)).not.toContain("secret");
  });

  it("redacts non-transient database failures", async () => {
    const source = Object.assign(new Error("submitted value and raw SQL"), { code: "42601" });
    const pool: LogQueryDatabasePool = { query: vi.fn(() => Promise.reject(source)) };
    const repository = createLogQueryRepository(pool);

    let thrown: unknown;
    try {
      await repository.findPage({ filters: filters(), limit: 10 });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InternalDatabaseError);
    expect(String(thrown)).not.toContain("submitted value");
    expect(String(thrown)).not.toContain("raw SQL");
  });
});
