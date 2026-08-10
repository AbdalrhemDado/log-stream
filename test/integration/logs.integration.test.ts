import { fileURLToPath } from "node:url";

import { Client, Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { loadMigrations } from "../../src/database/migrations/migration-loader.js";
import { runMigrationsWithOwnerRetry } from "../../src/database/migrations/migration-runner.js";
import type { MigrationOwnerConnection } from "../../src/database/migrations/migration-types.js";
import { buildPartitionPlan } from "../../src/database/partitions/partition-plan.js";
import { preparePartitions } from "../../src/database/partitions/partition-preparer.js";
import type { LogId } from "../../src/domain/log-entry.js";
import { createIngestionRepository } from "../../src/modules/ingestion/ingestion-repository.js";
import { createIngestionService } from "../../src/modules/ingestion/ingestion-service.js";
import { createLogQueryRepository } from "../../src/modules/query/log-query-repository.js";
import { createLogQueryService } from "../../src/modules/query/log-query-service.js";

const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
const adminBaseUrl = process.env["TEST_ADMIN_DATABASE_URL"];
const ownerBaseUrl = process.env["TEST_OWNER_DATABASE_URL"];
const runtimeBaseUrl = process.env["TEST_RUNTIME_DATABASE_URL"];
const hasPostgresEnvironment =
  adminBaseUrl !== undefined && ownerBaseUrl !== undefined && runtimeBaseUrl !== undefined;
const fixedCurrentTime = new Date("2026-08-09T12:00:00.000Z");
const validTimestamp = "2026-08-09T11:00:00.000Z";
let databaseSequence = 0;
let databaseName = "";
let runtimePool: Pool | undefined;
let app: ReturnType<typeof buildApp> | undefined;

function databaseUrl(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function trustedDatabaseIdentifier(name: string): string {
  if (!/^logstream_logs_http_test_[0-9]+_[0-9]+$/u.test(name)) {
    throw new Error("Refusing an unexpected POST /logs test database identifier.");
  }
  return `"${name}"`;
}

async function withClient<T>(connectionString: string, operation: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

function ownerConnection(connectionString: string): MigrationOwnerConnection {
  const client = new Client({ connectionString });
  return {
    connect: async () => {
      await client.connect();
    },
    end: async () => {
      await client.end();
    },
    query: async (sql, parameters) => client.query(sql, parameters),
  };
}

async function migrateAndPrepare(): Promise<void> {
  const ownerUrl = databaseUrl(ownerBaseUrl ?? "", databaseName);
  await runMigrationsWithOwnerRetry({
    createConnection: () => ownerConnection(ownerUrl),
    loadMigrations: async () => loadMigrations(migrationsDirectory),
    timeoutMs: 10_000,
    retryDelayMs: 20,
    afterMigrations: async ({ database, deadline, retryDelayMs, clock }) => {
      await preparePartitions({
        database,
        partitions: buildPartitionPlan(fixedCurrentTime, 1),
        deadline,
        retryDelayMs,
        clock,
      });
    },
  });
}

function buildHttpApplication(generateId: () => LogId): ReturnType<typeof buildApp> {
  if (runtimePool === undefined) {
    throw new Error("Runtime pool was not created.");
  }

  const repository = createIngestionRepository(runtimePool);
  const ingestionService = createIngestionService({
    repository,
    clock: () => fixedCurrentTime.getTime(),
    generateId,
  });
  const logQueryRepository = createLogQueryRepository(runtimePool);
  const logQueryService = createLogQueryService({ repository: logQueryRepository });
  return buildApp({ ingestionService, logQueryService });
}

function sequentialIdGenerator(): () => LogId {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}` as LogId;
  };
}

describe.skipIf(!hasPostgresEnvironment)("POST and GET /logs with PostgreSQL", () => {
  beforeEach(async () => {
    if (adminBaseUrl === undefined || runtimeBaseUrl === undefined) {
      throw new Error("PostgreSQL integration URLs are unavailable.");
    }

    databaseSequence += 1;
    databaseName = `logstream_logs_http_test_${String(process.pid)}_${String(databaseSequence)}`;
    await withClient(adminBaseUrl, async (admin) => {
      await admin.query(
        `CREATE DATABASE ${trustedDatabaseIdentifier(databaseName)} OWNER logstream_owner TEMPLATE template0`,
      );
    });
    await migrateAndPrepare();
    runtimePool = new Pool({
      connectionString: databaseUrl(runtimeBaseUrl, databaseName),
      max: 4,
    });
  });

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }

    if (runtimePool !== undefined) {
      await runtimePool.end();
      runtimePool = undefined;
    }

    if (adminBaseUrl === undefined || databaseName.length === 0) {
      return;
    }

    await withClient(adminBaseUrl, async (admin) => {
      await admin.query(`DROP DATABASE ${trustedDatabaseIdentifier(databaseName)} WITH (FORCE)`);
    });
  });

  it("durably persists only accepted mixed-batch entries with safe attributes", async () => {
    if (runtimePool === undefined) {
      throw new Error("Runtime pool was not created.");
    }

    app = buildHttpApplication(sequentialIdGenerator());
    const injectionText = "checkout'); DROP TABLE logstream.logs; --";
    const payload = `{"ignoredTop":{"admin":true},"logs":[{"timestamp":"${validTimestamp}","level":"error","service":${JSON.stringify(injectionText)},"message":"first valid","attributes":{"":"empty","שלום":"unicode","__proto__":"prototype","constructor":"constructor","retries":3,"enabled":true},"ignoredEntry":{"admin":true}},{"timestamp":"${validTimestamp}","level":"info","service":"unsafe\\u0000service","message":"NUL invalid"},{"timestamp":"${validTimestamp}","level":"warn","service":"nested-invalid","message":"nested invalid","attributes":{"nested":{"unsafe":true}}},{"timestamp":"${validTimestamp}","level":"info","service":"ordinary","message":"second valid"}]}`;

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      headers: { "content-type": "application/json" },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accepted: 2,
      rejected: [
        { index: 1, reason: "service must not contain U+0000" },
        { index: 2, reason: "attribute values must be strings, finite numbers, or booleans" },
      ],
    });

    const stored = await runtimePool.query<{
      id: string;
      service: string;
      message: string;
      attributes: Record<string, unknown>;
      attributes_search: Record<string, string>;
    }>(`
SELECT id, service, message, attributes, attributes_search
FROM logstream.logs
ORDER BY id
`);
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows.map((row) => row.service)).toEqual([injectionText, "ordinary"]);
    expect(stored.rows.map((row) => row.message)).toEqual(["first valid", "second valid"]);
    const first = stored.rows[0];
    expect(first?.attributes[""]).toBe("empty");
    expect(first?.attributes["שלום"]).toBe("unicode");
    expect(first?.attributes["__proto__"]).toBe("prototype");
    expect(Reflect.get(first?.attributes ?? {}, "constructor")).toBe("constructor");
    expect(first?.attributes["retries"]).toBe(3);
    expect(first?.attributes["enabled"]).toBe(true);
    expect(first?.attributes_search["retries"]).toBe("3");
    expect(first?.attributes_search["enabled"]).toBe("true");
    expect(Object.hasOwn(first?.attributes ?? {}, "ignoredEntry")).toBe(false);

    const tableEvidence = await runtimePool.query<{ table_name: string | null; count: number }>(`
SELECT
  to_regclass('logstream.logs')::text AS table_name,
  (SELECT COUNT(*)::integer FROM logstream.logs) AS count
`);
    expect(tableEvidence.rows).toEqual([{ table_name: "logstream.logs", count: 2 }]);
  });

  it("returns 400 for an all-invalid batch without inserting rows", async () => {
    if (runtimePool === undefined) {
      throw new Error("Runtime pool was not created.");
    }

    app = buildHttpApplication(sequentialIdGenerator());

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: [{ timestamp: validTimestamp, level: "info", service: "", message: "invalid" }, null],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      accepted: 0,
      rejected: [
        { index: 0, reason: "service must be non-empty" },
        { index: 1, reason: "log entry must be a non-null object" },
      ],
    });

    const evidence = await runtimePool.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM logstream.logs",
    );
    expect(evidence.rows).toEqual([{ count: 0 }]);
  });

  it("returns generic 500 and rolls back the whole request after a genuine duplicate-ID failure", async () => {
    if (runtimePool === undefined) {
      throw new Error("Runtime pool was not created.");
    }

    const duplicateId = "00000000-0000-4000-8000-000000000999" as LogId;
    app = buildHttpApplication(() => duplicateId);
    const submittedSecret = "secret-service-value";

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: [
          {
            timestamp: validTimestamp,
            level: "info",
            service: submittedSecret,
            message: "first duplicate ID",
          },
          {
            timestamp: validTimestamp,
            level: "error",
            service: "second-service-value",
            message: "second duplicate ID",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('{"error":"Internal server error."}');
    expect(response.body).not.toContain("accepted");
    expect(response.body).not.toContain("23505");
    expect(response.body).not.toContain("duplicate key");
    expect(response.body).not.toContain("logstream.logs");
    expect(response.body).not.toContain(submittedSecret);
    expect(response.body).not.toContain("second-service-value");

    const evidence = await runtimePool.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM logstream.logs",
    );
    expect(evidence.rows).toEqual([{ count: 0 }]);
  });

  it("retrieves an ingested log with omitted attributes as the exact QRY-012 response", async () => {
    app = buildHttpApplication(sequentialIdGenerator());

    const ingestion = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: [
          {
            timestamp: validTimestamp,
            level: "info",
            service: "omitted-attributes",
            message: "no attributes supplied",
          },
        ],
      },
    });
    expect(ingestion.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: "/logs?service=omitted-attributes",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      logs: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          timestamp: validTimestamp,
          level: "info",
          service: "omitted-attributes",
          message: "no attributes supplied",
          attributes: {},
        },
      ],
      next_cursor: null,
    });
  });

  it("returns public QRY-004 HTTP 400 when until is earlier than since", async () => {
    app = buildHttpApplication(sequentialIdGenerator());

    const response = await app.inject({
      method: "GET",
      url: "/logs?since=2026-08-09T12%3A00%3A00.000Z&until=2026-08-09T11%3A59%3A59.999Z",
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(
      "{\"error\":\"Query parameter 'until' must not be earlier than 'since'.\"}",
    );
    const evidence = await runtimePool?.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM logstream.logs",
    );
    expect(evidence?.rows).toEqual([{ count: 0 }]);
  });

  it("rejects filter-mismatched and malformed cursors through the assembled application", async () => {
    app = buildHttpApplication(sequentialIdGenerator());
    const cursorSourceFilter = "cursor-source";
    const submittedFilter = "cursor-target";
    const ingestion = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: [
          {
            timestamp: "2026-08-09T11:00:00.000Z",
            level: "info",
            service: cursorSourceFilter,
            message: "newer cursor source row",
          },
          {
            timestamp: "2026-08-09T10:59:59.000Z",
            level: "info",
            service: cursorSourceFilter,
            message: "older cursor source row",
          },
        ],
      },
    });
    expect(ingestion.statusCode).toBe(200);

    const firstPage = await app.inject({
      method: "GET",
      url: `/logs?service=${cursorSourceFilter}&limit=1`,
    });
    expect(firstPage.statusCode).toBe(200);
    const validCursor = firstPage.json<{ next_cursor: string | null }>().next_cursor;
    expect(validCursor).not.toBeNull();
    if (validCursor === null) {
      throw new Error("Expected the first real PostgreSQL page to provide a cursor.");
    }

    const cases = [
      {
        name: "different normalized filter",
        cursor: validCursor,
        url: `/logs?service=${submittedFilter}&cursor=${encodeURIComponent(validCursor)}`,
      },
      {
        name: "malformed cursor",
        cursor: "not-a-valid-cursor",
        url: "/logs?service=cursor-source&cursor=not-a-valid-cursor",
      },
    ] as const;

    for (const testCase of cases) {
      const response = await app.inject({ method: "GET", url: testCase.url });

      expect(response.statusCode, testCase.name).toBe(400);
      expect(response.body, testCase.name).toBe(
        '{"error":"Query parameter \'cursor\' is invalid."}',
      );
      for (const sensitiveText of [
        testCase.cursor,
        cursorSourceFilter,
        submittedFilter,
        "filterFingerprint",
        "SELECT",
        "logstream.logs",
        "postgresql://",
      ]) {
        expect(response.body, testCase.name).not.toContain(sensitiveText);
      }
    }
  });

  it("combines every filter and keeps literal message search characters as data", async () => {
    app = buildHttpApplication(sequentialIdGenerator());
    const payload = `{"logs":[{"timestamp":"2026-08-09T11:00:00.123456Z","level":"error","service":"checkout","message":"Payment DECLINED literal % _ \\\\ path","attributes":{"retries":3,"enabled":true,"region":"eu-west"}},{"timestamp":"2026-08-09T11:00:00.123455Z","level":"error","service":"checkout","message":"other candidate","attributes":{"retries":3,"enabled":false,"region":"eu-west"}},{"timestamp":"2026-08-09T10:59:59.999999Z","level":"info","service":"auth","message":"ordinary","attributes":{"retries":"03"}}]}`;
    const ingestion = await app.inject({
      method: "POST",
      url: "/logs",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(ingestion.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: "/logs?service=checkout&level=error&since=2026-08-09T11%3A00%3A00.123456Z&until=2026-08-09T11%3A00%3A00.123457Z&attr.retries=3&attr.enabled=true&q=%25%20_%20%5C&limit=10",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      logs: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          timestamp: "2026-08-09T11:00:00.123456Z",
          level: "error",
          service: "checkout",
          attributes: { retries: 3, enabled: true, region: "eu-west" },
        },
      ],
      next_cursor: null,
    });

    const stringComparison = await app.inject({
      method: "GET",
      url: "/logs?attr.retries=03",
    });
    expect(stringComparison.json()).toMatchObject({
      logs: [{ service: "auth", attributes: { retries: "03" } }],
    });
  });

  it("traverses deterministic pages with equal and microsecond-distinct timestamps", async () => {
    app = buildHttpApplication(sequentialIdGenerator());
    const timestamps = [
      "2026-08-09T11:00:00.123456Z",
      "2026-08-09T11:00:00.123456Z",
      "2026-08-09T11:00:00.123455Z",
      "2026-08-09T11:00:00.123400Z",
      "2026-08-09T11:00:00.123000Z",
    ];
    const ingestion = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: timestamps.map((timestamp, index) => ({
          timestamp,
          level: "info",
          service: "pagination",
          message: `page row ${String(index + 1)}`,
        })),
      },
    });
    expect(ingestion.statusCode).toBe(200);

    const seen: string[] = [];
    let cursor: string | null = null;
    const limits = ["2", "1", "2", "2"];
    for (const limit of limits) {
      const cursorParameter = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const response = await app.inject({
        method: "GET",
        url: `/logs?service=pagination&limit=${limit}${cursorParameter}`,
      });
      expect(response.statusCode).toBe(200);
      const body: {
        logs: { id: string; timestamp: string }[];
        next_cursor: string | null;
      } = response.json();
      seen.push(...body.logs.map((row) => row.id));
      cursor = body.next_cursor;
      if (cursor === null) {
        break;
      }
    }

    expect(seen).toEqual([
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000004",
      "00000000-0000-4000-8000-000000000005",
    ]);
    expect(new Set(seen).size).toBe(5);
    expect(cursor).toBeNull();
  });

  it("preserves prototype-sensitive query attributes without pollution or injection", async () => {
    if (runtimePool === undefined) {
      throw new Error("Runtime pool was not created.");
    }
    app = buildHttpApplication(sequentialIdGenerator());
    const payload = `{"logs":[{"timestamp":"${validTimestamp}","level":"error","service":"safe-service","message":"safe message","attributes":{"__proto__":"prototype-value","constructor":"constructor-value","unicode-שלום":"ערך-世界","backslash-\\\\key":"value-\\\\path"}}]}`;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/logs",
          headers: { "content-type": "application/json" },
          payload,
        })
      ).statusCode,
    ).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: "/logs?attr.__proto__=prototype-value&attr.constructor=constructor-value&attr.unicode-%D7%A9%D7%9C%D7%95%D7%9D=%D7%A2%D7%A8%D7%9A-%E4%B8%96%E7%95%8C&attr.backslash-%5Ckey=value-%5Cpath",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      logs: [
        {
          attributes: {
            __proto__: "prototype-value",
            constructor: "constructor-value",
            "unicode-שלום": "ערך-世界",
            "backslash-\\key": "value-\\path",
          },
        },
      ],
    });
    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();

    const injection = await app.inject({
      method: "GET",
      url: `/logs?service=${encodeURIComponent("safe-service' OR TRUE --")}`,
    });
    expect(injection.json()).toEqual({ logs: [], next_cursor: null });
    const evidence = await runtimePool.query<{ table_name: string; count: number }>(`
SELECT
  to_regclass('logstream.logs')::text AS table_name,
  (SELECT COUNT(*)::integer FROM logstream.logs) AS count
`);
    expect(evidence.rows).toEqual([{ table_name: "logstream.logs", count: 1 }]);
  });

  it("continues deterministically across read-committed inserts and owner deletion", async () => {
    if (runtimePool === undefined || ownerBaseUrl === undefined) {
      throw new Error("PostgreSQL integration resources are unavailable.");
    }
    app = buildHttpApplication(sequentialIdGenerator());
    const initial = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: Array.from({ length: 4 }, (_, index) => ({
          timestamp: validTimestamp,
          level: "info",
          service: "concurrent-page",
          message: `original ${String(index + 1)}`,
        })),
      },
    });
    expect(initial.statusCode).toBe(200);

    const firstResponse = await app.inject({
      method: "GET",
      url: "/logs?service=concurrent-page&limit=2",
    });
    const first = firstResponse.json<{ logs: { id: string }[]; next_cursor: string }>();
    expect(first.logs.map((row) => row.id)).toEqual([
      "00000000-0000-4000-8000-000000000004",
      "00000000-0000-4000-8000-000000000003",
    ]);

    const newer = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: [
          {
            timestamp: "2026-08-09T11:30:00.000Z",
            level: "info",
            service: "concurrent-page",
            message: "inserted ahead of cursor",
          },
        ],
      },
    });
    expect(newer.statusCode).toBe(200);

    await withClient(databaseUrl(ownerBaseUrl, databaseName), async (owner) => {
      await owner.query("DELETE FROM logstream.logs WHERE id = $1::uuid", [
        "00000000-0000-4000-8000-000000000002",
      ]);
    });

    const continuation = await app.inject({
      method: "GET",
      url: `/logs?service=concurrent-page&limit=2&cursor=${encodeURIComponent(first.next_cursor)}`,
    });
    const second = continuation.json<{
      logs: { id: string; message: string }[];
      next_cursor: string | null;
    }>();
    expect(second.logs.map((row) => row.id)).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(second.logs.map((row) => row.message)).not.toContain("inserted ahead of cursor");
    expect(second.next_cursor).toBeNull();
  });
});
