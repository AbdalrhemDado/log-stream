import { describe, expect, it, vi } from "vitest";

import { InternalDatabaseError } from "../../src/database/database-errors.js";
import type { CanonicalUtcTimestamp } from "../../src/domain/log-entry.js";
import type { ParsedLogAggregationQuery } from "../../src/modules/aggregation/aggregation-parameter-parser.js";
import {
  createLogAggregationRepository,
  type LogAggregationDatabasePool,
} from "../../src/modules/aggregation/log-aggregation-repository.js";
import type { LogFilters } from "../../src/modules/query/query-parameter-parser.js";
import { TransientServiceError } from "../../src/shared/app-error.js";

const SINCE = "2026-08-09T10:00:00.000Z" as CanonicalUtcTimestamp;
const UNTIL = "2026-08-09T12:00:00.000Z" as CanonicalUtcTimestamp;

function filters(overrides: Partial<LogFilters> = {}): LogFilters & {
  readonly since: CanonicalUtcTimestamp;
  readonly until: CanonicalUtcTimestamp;
} {
  return { attributes: [], since: SINCE, until: UNTIL, ...overrides };
}

function request(overrides: Partial<ParsedLogAggregationQuery> = {}): ParsedLogAggregationQuery {
  return { filters: filters(), bucket: "1m", ...overrides };
}

function databaseRow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    start: "2026-08-09T10:00:00.000000Z",
    group: null,
    count: "2",
    ...overrides,
  };
}

function databaseDouble(rows: readonly unknown[] = [databaseRow()]) {
  const query = vi.fn(() => Promise.resolve({ rows }));
  const pool: LogAggregationDatabasePool = { query };
  return { pool, query };
}

function firstQueryCall(query: ReturnType<typeof vi.fn>): [string, unknown[]] {
  const call = query.mock.calls[0];
  if (call === undefined || !Array.isArray(call[1])) {
    throw new Error("Expected one parameterized aggregation query.");
  }

  return [String(call[0]), call[1] as unknown[]];
}

describe("aggregation repository SQL", () => {
  it.each([
    { bucket: "1m" as const, interval: "INTERVAL '1 minute'" },
    { bucket: "5m" as const, interval: "INTERVAL '5 minutes'" },
    { bucket: "1h" as const, interval: "INTERVAL '1 hour'" },
    { bucket: "1d" as const, interval: "INTERVAL '1 day'" },
  ])("uses the trusted $bucket interval", async ({ bucket, interval }) => {
    const database = databaseDouble([]);
    const repository = createLogAggregationRepository(database.pool);

    await repository.aggregate(request({ bucket }));

    expect(database.query).toHaveBeenCalledOnce();
    const [sql, values] = firstQueryCall(database.query);
    expect(sql).toContain(`date_bin(\n      ${interval},`);
    expect(sql).toContain("TIMESTAMPTZ '1970-01-01 00:00:00+00'");
    expect(sql).not.toContain("date_trunc");
    expect(values).toEqual([SINCE, UNTIL]);
  });

  it("uses fixed ungrouped SQL and orders only by raw bucket start", async () => {
    const database = databaseDouble([]);
    const repository = createLogAggregationRepository(database.pool);

    await repository.aggregate(request());

    const [sql] = firstQueryCall(database.query);
    expect(sql).toContain("NULL::text AS group_value");
    expect(sql).toContain("GROUP BY 1\n");
    expect(sql).not.toContain("GROUP BY 1, 2");
    expect(sql).toContain("ORDER BY aggregation.bucket_start ASC\n");
    expect(sql).not.toContain("aggregation.group_value ASC");
  });

  it.each([
    { groupBy: "service" as const, expression: "logs.service" },
    { groupBy: "level" as const, expression: "logs.level" },
  ])("uses only the trusted $groupBy grouping", async ({ groupBy, expression }) => {
    const database = databaseDouble([databaseRow({ group: groupBy === "level" ? "info" : "a" })]);
    const repository = createLogAggregationRepository(database.pool);

    await repository.aggregate(request({ groupBy }));

    const [sql] = firstQueryCall(database.query);
    expect(sql).toContain(`${expression} AS group_value`);
    expect(sql).toContain("GROUP BY 1, 2");
    expect(sql).toContain("ORDER BY aggregation.bucket_start ASC, aggregation.group_value ASC");
  });

  it("keeps every filter in deterministic placeholder order", async () => {
    const database = databaseDouble([]);
    const repository = createLogAggregationRepository(database.pool);

    await repository.aggregate(
      request({
        filters: filters({
          service: "checkout",
          level: "error",
          attributes: [
            { key: "", value: "" },
            { key: "__proto__", value: "prototype" },
            { key: "backslash-\\key", value: "value-\\path" },
            { key: "constructor", value: "constructor" },
            { key: "toString", value: "to-string" },
            { key: "שלום", value: "世界" },
          ],
          q: "Payment%_\\Declined",
        }),
      }),
    );

    const [sql, values] = firstQueryCall(database.query);
    expect(values).toEqual([
      "checkout",
      "error",
      SINCE,
      UNTIL,
      '{"":""}',
      '{"__proto__":"prototype"}',
      '{"backslash-\\\\key":"value-\\\\path"}',
      '{"constructor":"constructor"}',
      '{"toString":"to-string"}',
      '{"שלום":"世界"}',
      "%Payment\\%\\_\\\\Declined%",
    ]);
    expect(sql).toContain("service = $1::text");
    expect(sql).toContain("level = $2::text");
    expect(sql).toContain('"timestamp" >= $3::timestamptz');
    expect(sql).toContain('"timestamp" < $4::timestamptz');
    expect(sql).toContain("attributes_search @> $5::jsonb");
    expect(sql).toContain("attributes_search @> $10::jsonb");
    expect(sql).toContain("message ILIKE $11::text ESCAPE E'\\\\'");
    expect(sql).toContain("aggregation.bucket_start AT TIME ZONE 'UTC'");
    expect(sql).toContain("aggregation.count::text AS count");
    expect(sql).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bBEGIN\b|\bCOMMIT\b/iu);
  });

  it("keeps hostile filters out of SQL while leaving them in parameters", async () => {
    const database = databaseDouble([]);
    const repository = createLogAggregationRepository(database.pool);
    const service = "checkout'); DROP TABLE logstream.logs; --";
    const key = 'key"} OR TRUE --';
    const value = "value'); SELECT pg_sleep(10); --";
    const q = "%_\\' UNION SELECT";

    await repository.aggregate(
      request({ filters: filters({ service, attributes: [{ key, value }], q }) }),
    );

    const [sql, values] = firstQueryCall(database.query);
    for (const submitted of [service, key, value, q]) {
      expect(sql).not.toContain(submitted);
    }
    expect(values[0]).toBe(service);
    expect(JSON.parse(String(values[3]))).toEqual({ [key]: value });
  });

  it.each([
    { name: "bucket", request: request({ bucket: "__proto__" as "1m" }) },
    { name: "group", request: request({ groupBy: "constructor" as "service" }) },
  ])("rejects a forged $name before querying", async ({ request: forged }) => {
    const database = databaseDouble([]);
    const repository = createLogAggregationRepository(database.pool);

    await expect(repository.aggregate(forged)).rejects.toBeInstanceOf(InternalDatabaseError);
    expect(database.query).not.toHaveBeenCalled();
  });

  it.each([
    { name: "bucket", key: "bucket", validKey: "1m" },
    { name: "group", key: "groupBy", validKey: "service" },
  ] as const)("rejects a forged object $name without coercion", async ({ key, validKey }) => {
    let coercions = 0;
    const forged = {
      [Symbol.toPrimitive]: () => {
        coercions += 1;
        return validKey;
      },
      toString: () => {
        coercions += 1;
        return validKey;
      },
      valueOf: () => {
        coercions += 1;
        return validKey;
      },
    };
    const database = databaseDouble([]);
    const repository = createLogAggregationRepository(database.pool);
    const forgedRequest = request({ [key]: forged });

    await expect(repository.aggregate(forgedRequest)).rejects.toBeInstanceOf(InternalDatabaseError);
    expect(coercions).toBe(0);
    expect(database.query).not.toHaveBeenCalled();
  });

  it.each([
    { name: "bucket", request: request({ bucket: new String("1m") as unknown as "1m" }) },
    {
      name: "group",
      request: request({ groupBy: new String("service") as unknown as "service" }),
    },
  ])("rejects a boxed String $name before querying", async ({ request: forged }) => {
    const database = databaseDouble([]);
    const repository = createLogAggregationRepository(database.pool);

    await expect(repository.aggregate(forged)).rejects.toBeInstanceOf(InternalDatabaseError);
    expect(database.query).not.toHaveBeenCalled();
  });
});

describe("aggregation repository row mapping", () => {
  it("maps exact fields, canonical UTC time, null group, and a safe count", async () => {
    const database = databaseDouble([
      databaseRow({
        start: "2026-08-09T10:00:00.123400Z",
        ignored: "not public",
      }),
    ]);
    const repository = createLogAggregationRepository(database.pool);

    await expect(repository.aggregate(request())).resolves.toEqual([
      { start: "2026-08-09T10:00:00.1234Z", group: null, count: 2 },
    ]);
  });

  it("accepts the maximum safe count exactly", async () => {
    const database = databaseDouble([databaseRow({ count: String(Number.MAX_SAFE_INTEGER) })]);
    const repository = createLogAggregationRepository(database.pool);

    await expect(repository.aggregate(request())).resolves.toMatchObject([
      { count: Number.MAX_SAFE_INTEGER },
    ]);
  });

  it.each([
    "9007199254740992",
    "9999999999999999",
    "0",
    "00",
    "01",
    "-1",
    "+1",
    "1.0",
    "1e2",
    " 1",
    "1 ",
    "",
    1,
    null,
  ])("rejects a malformed or unsafe count: %j", async (count) => {
    const database = databaseDouble([databaseRow({ count })]);
    const repository = createLogAggregationRepository(database.pool);

    await expect(repository.aggregate(request())).rejects.toBeInstanceOf(InternalDatabaseError);
  });

  it.each([
    { name: "invalid row", row: null, request: request() },
    { name: "invalid start", row: databaseRow({ start: "invalid" }), request: request() },
    { name: "missing start", row: { group: null, count: "1" }, request: request() },
    {
      name: "non-null ungrouped value",
      row: databaseRow({ group: "service" }),
      request: request(),
    },
    {
      name: "non-string service group",
      row: databaseRow({ group: 42 }),
      request: request({ groupBy: "service" }),
    },
    {
      name: "invalid level group",
      row: databaseRow({ group: "critical" }),
      request: request({ groupBy: "level" }),
    },
  ])("rejects a malformed database boundary: $name", async ({ row, request: input }) => {
    const database = databaseDouble([row]);
    const repository = createLogAggregationRepository(database.pool);

    await expect(repository.aggregate(input)).rejects.toBeInstanceOf(InternalDatabaseError);
  });

  it.each(["start", "group", "count"] as const)(
    "rejects a non-enumerable or inherited %s",
    async (key) => {
      const nonEnumerable = databaseRow();
      Object.defineProperty(nonEnumerable, key, { enumerable: false, value: nonEnumerable[key] });
      const inheritedOwn = databaseRow();
      const inheritedValue = inheritedOwn[key];
      Reflect.deleteProperty(inheritedOwn, key);
      const inherited = Object.assign(
        Object.create({ [key]: inheritedValue }) as object,
        inheritedOwn,
      );
      const repository = createLogAggregationRepository(databaseDouble([nonEnumerable]).pool);
      const inheritedRepository = createLogAggregationRepository(databaseDouble([inherited]).pool);

      await expect(repository.aggregate(request())).rejects.toBeInstanceOf(InternalDatabaseError);
      await expect(inheritedRepository.aggregate(request())).rejects.toBeInstanceOf(
        InternalDatabaseError,
      );
    },
  );

  it.each(["start", "group", "count"] as const)(
    "rejects a %s accessor without invoking it",
    async (key) => {
      const row = databaseRow();
      let calls = 0;
      Object.defineProperty(row, key, {
        enumerable: true,
        get: () => {
          calls += 1;
          return "submitted-secret";
        },
      });
      const repository = createLogAggregationRepository(databaseDouble([row]).pool);

      await expect(repository.aggregate(request())).rejects.toBeInstanceOf(InternalDatabaseError);
      expect(calls).toBe(0);
    },
  );

  it("rejects malformed result rows", async () => {
    const pool = {
      query: vi.fn(() => Promise.resolve({ rows: "submitted-secret" })),
    } as unknown as LogAggregationDatabasePool;
    const repository = createLogAggregationRepository(pool);

    await expect(repository.aggregate(request())).rejects.toBeInstanceOf(InternalDatabaseError);
  });
});

describe("aggregation repository error translation", () => {
  it("preserves transient classification without retaining the source", async () => {
    const source = Object.assign(new Error("postgresql://runtime:secret@database/logstream"), {
      code: "ECONNREFUSED",
    });
    const pool: LogAggregationDatabasePool = {
      query: vi.fn(() => Promise.reject(source)),
    };
    const repository = createLogAggregationRepository(pool);

    let thrown: unknown;
    try {
      await repository.aggregate(request());
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TransientServiceError);
    expect(String(thrown)).not.toContain("secret");
    expect(thrown).not.toHaveProperty("cause");
  });

  it("redacts non-transient database failures", async () => {
    const source = Object.assign(new Error("submitted value and raw SQL"), { code: "42601" });
    const pool: LogAggregationDatabasePool = {
      query: vi.fn(() => Promise.reject(source)),
    };
    const repository = createLogAggregationRepository(pool);

    let thrown: unknown;
    try {
      await repository.aggregate(request());
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InternalDatabaseError);
    expect(String(thrown)).not.toContain("submitted value");
    expect(String(thrown)).not.toContain("raw SQL");
    expect(thrown).not.toHaveProperty("cause");
  });
});
