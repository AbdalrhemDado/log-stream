import { describe, expect, it, vi } from "vitest";

import { InternalDatabaseError } from "../../src/database/database-errors.js";
import { validateLogEntry } from "../../src/domain/log-entry-validator.js";
import type { LogId, LogInsertionRecord } from "../../src/domain/log-entry.js";
import {
  createIngestionRepository,
  type IngestionDatabasePool,
} from "../../src/modules/ingestion/ingestion-repository.js";
import { TransientServiceError } from "../../src/shared/app-error.js";

const REFERENCE_TIME_MS = Date.UTC(2026, 7, 8, 12, 0, 0, 0);

function insertionRecord(
  id: string,
  overrides: Partial<{
    readonly timestamp: string;
    readonly level: string;
    readonly service: string;
    readonly message: string;
    readonly attributes: object;
  }> = {},
): LogInsertionRecord {
  const result = validateLogEntry(
    {
      timestamp: overrides.timestamp ?? "2026-08-08T11:00:00.000Z",
      level: overrides.level ?? "info",
      service: overrides.service ?? "checkout",
      message: overrides.message ?? "payment accepted",
      attributes: overrides.attributes ?? {},
    },
    REFERENCE_TIME_MS,
  );

  if (!result.ok) {
    throw new Error(`Test record failed validation: ${result.reason}`);
  }

  return {
    ...result.value,
    id: id as LogId,
  };
}

function databaseDouble(queryImplementation?: (sql: string) => Promise<unknown>) {
  const query = vi.fn((sql: string, parameters?: unknown[]) => {
    void parameters;
    return queryImplementation === undefined
      ? Promise.resolve({ rowCount: 0, rows: [] })
      : queryImplementation(sql);
  });
  const pool: IngestionDatabasePool = { query };

  return { pool, query };
}

function querySqlCalls(query: ReturnType<typeof vi.fn>): string[] {
  return query.mock.calls.map((call) => String(call[0]));
}

describe("ingestion repository", () => {
  it("treats empty input as a connection-free no-op", async () => {
    const database = databaseDouble();
    const repository = createIngestionRepository(database.pool);

    await expect(repository.insert([])).resolves.toBeUndefined();

    expect(database.query).not.toHaveBeenCalled();
  });

  it("executes one atomic parameterized UNNEST INSERT", async () => {
    const query = vi.fn((sql: string) => {
      void sql;
      return Promise.resolve({ rowCount: 0, rows: [] });
    });
    const pool: IngestionDatabasePool = { query };
    const repository = createIngestionRepository(pool);

    await expect(
      repository.insert([insertionRecord("00000000-0000-4000-8000-000000000001")]),
    ).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledOnce();
    const insertSql = String(query.mock.calls[0]?.[0]);
    expect(insertSql.match(/\bUNNEST\b/gu)).toHaveLength(2);
    expect(insertSql).not.toContain("RETURNING");
  });

  it("builds parallel arrays for logs and minute aggregates", async () => {
    const database = databaseDouble();
    const repository = createIngestionRepository(database.pool);
    const records = [
      insertionRecord("00000000-0000-4000-8000-000000000001", {
        timestamp: "2026-08-08T10:00:00.000Z",
        level: "warn",
        service: "checkout",
        message: "first",
        attributes: { retries: 3, enabled: true },
      }),
      insertionRecord("00000000-0000-4000-8000-000000000002", {
        timestamp: "2026-08-08T11:00:00.000Z",
        level: "error",
        service: "billing",
        message: "second",
        attributes: { region: "eu-west" },
      }),
    ];

    await repository.insert(records);

    const insertCall = database.query.mock.calls[0];
    if (insertCall?.[1] === undefined) {
      throw new Error("Expected one parameterized INSERT call.");
    }
    const [sql, parameters] = insertCall;
    expect(sql).toContain("$1::timestamptz[]");
    expect(sql).toContain("$2::uuid[]");
    expect(sql.match(/::text\[\]/gu)).toHaveLength(5);
    expect(sql.match(/::jsonb\[\]/gu)).toHaveLength(2);
    expect(parameters).toHaveLength(11);
    expect(parameters.slice(0, 7)).toEqual([
      ["2026-08-08T10:00:00.000Z", "2026-08-08T11:00:00.000Z"],
      ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
      ["warn", "error"],
      ["checkout", "billing"],
      ["first", "second"],
      ['{"retries":3,"enabled":true}', '{"region":"eu-west"}'],
      ['{"retries":"3","enabled":"true"}', '{"region":"eu-west"}'],
    ]);
    expect(parameters.slice(7)).toEqual([
      ["2026-08-08T10:00:00.000Z", "2026-08-08T11:00:00.000Z"],
      ["checkout", "billing"],
      ["warn", "error"],
      [1, 1],
    ]);
  });

  it("keeps hostile record text only in parameter values and never in SQL", async () => {
    const database = databaseDouble();
    const repository = createIngestionRepository(database.pool);
    const hostileService = "checkout'); DROP TABLE logstream.logs; --";
    const hostileMessage = "message $1::uuid[] /* SQL */";
    const hostileKey = "__proto__'); SELECT pg_sleep(10); --";
    const hostileValue = "secret-value'); COMMIT; --";
    const attributes = Object.create(null) as Record<string, unknown>;
    attributes[hostileKey] = hostileValue;

    await repository.insert([
      insertionRecord("00000000-0000-4000-8000-000000000003", {
        service: hostileService,
        message: hostileMessage,
        attributes,
      }),
    ]);

    const insertCall = database.query.mock.calls[0];
    if (insertCall?.[1] === undefined) {
      throw new Error("Expected one parameterized INSERT call.");
    }
    const [sql, parameters] = insertCall;
    for (const hostileText of [hostileService, hostileMessage, hostileKey, hostileValue]) {
      expect(sql).not.toContain(hostileText);
    }
    expect(parameters[3]).toEqual([hostileService]);
    expect(parameters[4]).toEqual([hostileMessage]);
    expect(String((parameters[5] as string[])[0])).toContain(hostileKey);
    expect(String((parameters[5] as string[])[0])).toContain(hostileValue);
  });

  it("translates an insert failure without exposing database details", async () => {
    const database = databaseDouble((sql) => {
      if (sql.includes("INSERT INTO")) {
        return Promise.reject(
          Object.assign(new Error("duplicate secret-service in raw SQL"), { code: "23505" }),
        );
      }
      return Promise.resolve({ rowCount: 0, rows: [] });
    });
    const repository = createIngestionRepository(database.pool);

    await expect(
      repository.insert([insertionRecord("00000000-0000-4000-8000-000000000004")]),
    ).rejects.toBeInstanceOf(InternalDatabaseError);

    expect(querySqlCalls(database.query)).toHaveLength(1);
  });

  it("does not leak the source error from a failed implicit transaction", async () => {
    const insertSecret = "insert SQL and credential secret";
    const database = databaseDouble((sql) => {
      if (sql.includes("INSERT INTO")) {
        return Promise.reject(Object.assign(new Error(insertSecret), { code: "23514" }));
      }
      return Promise.resolve({ rowCount: 0, rows: [] });
    });
    const repository = createIngestionRepository(database.pool);

    let thrown: unknown;
    try {
      await repository.insert([insertionRecord("00000000-0000-4000-8000-000000000007")]);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InternalDatabaseError);
    expect(String(thrown)).not.toContain(insertSecret);
  });

  it("translates a pool query failure without exposing its source", async () => {
    const sourceSecret = "postgresql://runtime:secret@database/logstream";
    const pool: IngestionDatabasePool = {
      query: vi.fn(() =>
        Promise.reject(Object.assign(new Error(sourceSecret), { code: "ECONNREFUSED" })),
      ),
    };
    const repository = createIngestionRepository(pool);

    let thrown: unknown;
    try {
      await repository.insert([insertionRecord("00000000-0000-4000-8000-000000000008")]);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TransientServiceError);
    expect(String(thrown)).not.toContain(sourceSecret);
  });

  it("uses one INSERT query regardless of record count", async () => {
    const database = databaseDouble();
    const repository = createIngestionRepository(database.pool);
    const records = Array.from({ length: 25 }, (_, index) =>
      insertionRecord(`00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`),
    );

    await repository.insert(records);

    expect(database.query).toHaveBeenCalledOnce();
    expect(querySqlCalls(database.query).filter((sql) => sql.includes("INSERT INTO"))).toHaveLength(
      1,
    );
  });
});
