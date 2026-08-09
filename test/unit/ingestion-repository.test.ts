import { describe, expect, it, vi } from "vitest";

import { InternalDatabaseError } from "../../src/database/database-errors.js";
import { normalizeAttributes } from "../../src/domain/attribute-normalizer.js";
import { validateLogEntry } from "../../src/domain/log-entry-validator.js";
import type { LogId, LogInsertionRecord } from "../../src/domain/log-entry.js";
import {
  createIngestionRepository,
  type IngestionDatabaseClient,
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
    attributesSearch: normalizeAttributes(result.value.attributes),
  };
}

function databaseDouble(queryImplementation?: (sql: string) => Promise<unknown>) {
  const query = vi.fn((sql: string, parameters?: unknown[]) => {
    void parameters;
    return queryImplementation === undefined
      ? Promise.resolve({ rowCount: 0, rows: [] })
      : queryImplementation(sql);
  });
  const release = vi.fn();
  const client: IngestionDatabaseClient = { query, release };
  const connect = vi.fn(() => Promise.resolve(client));
  const pool: IngestionDatabasePool = { connect };

  return { pool, connect, query, release };
}

function querySqlCalls(query: ReturnType<typeof vi.fn>): string[] {
  return query.mock.calls.map((call) => String(call[0]));
}

describe("ingestion repository", () => {
  it("treats empty input as a connection-free no-op", async () => {
    const database = databaseDouble();
    const repository = createIngestionRepository(database.pool);

    await expect(repository.insert([])).resolves.toBeUndefined();

    expect(database.connect).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
    expect(database.release).not.toHaveBeenCalled();
  });

  it("executes BEGIN, one parameterized UNNEST INSERT, and COMMIT before releasing", async () => {
    const events: string[] = [];
    const query = vi.fn((sql: string) => {
      events.push(sql.trimStart().split(/\s/u, 1)[0] ?? "");
      return Promise.resolve({ rowCount: 0, rows: [] });
    });
    const release = vi.fn(() => {
      events.push("RELEASE");
    });
    const pool: IngestionDatabasePool = {
      connect: vi.fn(() => Promise.resolve({ query, release })),
    };
    const repository = createIngestionRepository(pool);

    await expect(
      repository.insert([insertionRecord("00000000-0000-4000-8000-000000000001")]),
    ).resolves.toBeUndefined();

    expect(events).toEqual(["BEGIN", "INSERT", "COMMIT", "RELEASE"]);
    expect(query).toHaveBeenCalledTimes(3);
    const insertSql = String(query.mock.calls[1]?.[0]);
    expect(insertSql.match(/\bUNNEST\b/gu)).toHaveLength(1);
    expect(insertSql).not.toContain("RETURNING");
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith();
  });

  it("builds seven same-length parallel arrays in record and column order", async () => {
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

    const insertCall = database.query.mock.calls[1];
    if (insertCall?.[1] === undefined) {
      throw new Error("Expected one parameterized INSERT call.");
    }
    const [sql, parameters] = insertCall;
    expect(sql).toContain("$1::timestamptz[]");
    expect(sql).toContain("$2::uuid[]");
    expect(sql.match(/::text\[\]/gu)).toHaveLength(3);
    expect(sql.match(/::jsonb\[\]/gu)).toHaveLength(2);
    expect(parameters).toHaveLength(7);
    expect(
      parameters.every((parameter) => Array.isArray(parameter) && parameter.length === 2),
    ).toBe(true);
    expect(parameters).toEqual([
      ["2026-08-08T10:00:00.000Z", "2026-08-08T11:00:00.000Z"],
      ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
      ["warn", "error"],
      ["checkout", "billing"],
      ["first", "second"],
      ['{"retries":3,"enabled":true}', '{"region":"eu-west"}'],
      ['{"retries":"3","enabled":"true"}', '{"region":"eu-west"}'],
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

    const insertCall = database.query.mock.calls[1];
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

  it("rolls back an insert failure, never commits, releases, and throws a safe error", async () => {
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

    expect(querySqlCalls(database.query).map((sql) => sql.trim().split(/\s/u, 1)[0])).toEqual([
      "BEGIN",
      "INSERT",
      "ROLLBACK",
    ]);
    expect(database.query).not.toHaveBeenCalledWith("COMMIT");
    expect(database.release).toHaveBeenCalledOnce();
    expect(database.release).toHaveBeenCalledWith();
  });

  it("translates a BEGIN failure and releases without rollback or false commit", async () => {
    const database = databaseDouble(() =>
      Promise.reject(Object.assign(new Error("database is down"), { code: "ECONNREFUSED" })),
    );
    const repository = createIngestionRepository(database.pool);

    await expect(
      repository.insert([insertionRecord("00000000-0000-4000-8000-000000000005")]),
    ).rejects.toBeInstanceOf(TransientServiceError);

    expect(querySqlCalls(database.query)).toEqual(["BEGIN"]);
    expect(database.release).toHaveBeenCalledOnce();
    expect(database.release).toHaveBeenCalledWith(true);
  });

  it("reports no success and attempts rollback when COMMIT fails", async () => {
    const database = databaseDouble((sql) => {
      if (sql === "COMMIT") {
        return Promise.reject(
          Object.assign(new Error("connection lost during commit"), { code: "08007" }),
        );
      }
      return Promise.resolve({ rowCount: 0, rows: [] });
    });
    const repository = createIngestionRepository(database.pool);

    await expect(
      repository.insert([insertionRecord("00000000-0000-4000-8000-000000000006")]),
    ).rejects.toBeInstanceOf(TransientServiceError);

    expect(querySqlCalls(database.query).map((sql) => sql.trim().split(/\s/u, 1)[0])).toEqual([
      "BEGIN",
      "INSERT",
      "COMMIT",
      "ROLLBACK",
    ]);
    expect(database.release).toHaveBeenCalledOnce();
    expect(database.release).toHaveBeenCalledWith();
  });

  it("does not let rollback failure leak or replace the translated insert failure", async () => {
    const insertSecret = "insert SQL and credential secret";
    const rollbackSecret = "rollback password secret";
    const database = databaseDouble((sql) => {
      if (sql.includes("INSERT INTO")) {
        return Promise.reject(Object.assign(new Error(insertSecret), { code: "23514" }));
      }
      if (sql === "ROLLBACK") {
        return Promise.reject(new Error(rollbackSecret));
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
    expect(String(thrown)).not.toContain(rollbackSecret);
    expect(database.release).toHaveBeenCalledOnce();
    expect(database.release).toHaveBeenCalledWith(true);
  });

  it("translates pool acquisition failure without exposing its source", async () => {
    const sourceSecret = "postgresql://runtime:secret@database/logstream";
    const pool: IngestionDatabasePool = {
      connect: vi.fn(() =>
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

    expect(database.query).toHaveBeenCalledTimes(3);
    expect(querySqlCalls(database.query).filter((sql) => sql.includes("INSERT INTO"))).toHaveLength(
      1,
    );
  });
});
