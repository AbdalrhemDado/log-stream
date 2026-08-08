import { describe, expect, it, vi } from "vitest";

import {
  MigrationChecksumMismatchError,
  MigrationConnectionError,
  MigrationExecutionError,
  MigrationFilenameMismatchError,
  MigrationLockError,
  MigrationLockTimeoutError,
  MigrationOwnerStartupTimeoutError,
  MissingLocalMigrationError,
} from "../../src/database/migrations/migration-errors.js";
import {
  migrateBeforeRuntime,
  runMigrations,
  runMigrationsWithOwner,
  runMigrationsWithOwnerRetry,
} from "../../src/database/migrations/migration-runner.js";
import type {
  MigrationClock,
  MigrationDatabase,
  MigrationFile,
  MigrationOwnerConnection,
  MigrationQueryResult,
} from "../../src/database/migrations/migration-types.js";

interface QueryCall {
  readonly sql: string;
  readonly parameters: unknown[] | undefined;
}

function migration(version: number): MigrationFile {
  return {
    version,
    filename: `${String(version).padStart(4, "0")}_migration.sql`,
    checksum: String(version).padStart(64, "0"),
    sql: `SELECT ${String(version)} AS migration_${String(version)}`,
  };
}

class RecordingDatabase implements MigrationDatabase {
  public readonly calls: QueryCall[] = [];
  private lockAttempt = 0;

  public constructor(
    private readonly history: readonly unknown[] = [],
    private readonly failWhen: (sql: string, parameters: unknown[] | undefined) => boolean = () =>
      false,
    private readonly lockAvailability: readonly boolean[] = [true],
  ) {}

  public query(sql: string, parameters?: unknown[]): Promise<MigrationQueryResult> {
    this.calls.push({ sql, parameters });
    if (this.failWhen(sql, parameters)) {
      return Promise.reject(new Error("postgresql://owner:secret-password@database/logs"));
    }
    if (sql.includes("pg_try_advisory_lock")) {
      const acquired =
        this.lockAvailability[this.lockAttempt] ?? this.lockAvailability.at(-1) ?? true;
      this.lockAttempt += 1;
      return Promise.resolve({ rows: [{ acquired }] });
    }
    if (sql.includes("pg_advisory_unlock")) {
      return Promise.resolve({ rows: [{ released: true }] });
    }
    if (sql.includes("SELECT version, filename, checksum")) {
      return Promise.resolve({ rows: this.history });
    }
    return Promise.resolve({ rows: [] });
  }
}

function createClock(): {
  readonly clock: MigrationClock;
  readonly sleeps: number[];
} {
  let currentTime = 0;
  const sleeps: number[] = [];
  return {
    clock: {
      now: () => currentTime,
      sleep: (delayMs) => {
        sleeps.push(delayMs);
        currentTime += delayMs;
        return Promise.resolve();
      },
      runWithTimeout: async <T>(operation: Promise<T>): Promise<T> => operation,
    },
    sleeps,
  };
}

function retryableConnectionError(): Error & { readonly code: string } {
  return Object.assign(new Error("postgresql://owner:secret-password@database/logs"), {
    code: "ECONNREFUSED",
  });
}

function callsMatching(database: RecordingDatabase, fragment: string): readonly QueryCall[] {
  return database.calls.filter((call) => call.sql.includes(fragment));
}

describe("runMigrations", () => {
  it("does no migration work when every local migration matches history", async () => {
    const local = migration(1);
    const database = new RecordingDatabase([local]);

    await expect(
      runMigrations({ database, loadMigrations: () => Promise.resolve([local]) }),
    ).resolves.toEqual({ appliedVersions: [] });

    expect(callsMatching(database, local.sql)).toHaveLength(0);
  });

  it("applies a pending migration in one transaction", async () => {
    const local = migration(1);
    const database = new RecordingDatabase();

    await expect(
      runMigrations({ database, loadMigrations: () => Promise.resolve([local]) }),
    ).resolves.toEqual({ appliedVersions: [1] });

    const migrationIndex = database.calls.findIndex((call) => call.sql === local.sql);
    expect(database.calls[migrationIndex - 1]?.sql).toBe("BEGIN");
    expect(database.calls[migrationIndex + 1]?.sql).toContain("INSERT INTO");
    expect(database.calls[migrationIndex + 2]?.sql).toBe("COMMIT");
  });

  it("applies multiple pending migrations in numeric plan order", async () => {
    const local = [migration(1), migration(2), migration(10)];
    const database = new RecordingDatabase();

    await expect(
      runMigrations({ database, loadMigrations: () => Promise.resolve(local) }),
    ).resolves.toEqual({ appliedVersions: [1, 2, 10] });

    expect(
      database.calls
        .filter((call) => local.some((item) => item.sql === call.sql))
        .map((call) => call.sql),
    ).toEqual(local.map((item) => item.sql));
  });

  it("parameterizes the migration history insert", async () => {
    const local = migration(3);
    const database = new RecordingDatabase();

    await runMigrations({ database, loadMigrations: () => Promise.resolve([local]) });

    const [historyInsert] = callsMatching(database, "INSERT INTO");
    expect(historyInsert?.sql).toContain("VALUES ($1, $2, $3)");
    expect(historyInsert?.parameters).toEqual([3, local.filename, local.checksum]);
    expect(historyInsert?.sql).not.toContain(local.filename);
  });

  it("leaves an existing matching migration untouched", async () => {
    const local = migration(1);
    const database = new RecordingDatabase([local]);

    await runMigrations({ database, loadMigrations: () => Promise.resolve([local]) });

    expect(callsMatching(database, "INSERT INTO")).toHaveLength(0);
    expect(callsMatching(database, local.sql)).toHaveLength(0);
  });

  it("rejects a checksum mismatch", async () => {
    const local = migration(1);
    const database = new RecordingDatabase([{ ...local, checksum: "f".repeat(64) }]);

    await expect(
      runMigrations({ database, loadMigrations: () => Promise.resolve([local]) }),
    ).rejects.toBeInstanceOf(MigrationChecksumMismatchError);
  });

  it("rejects a filename mismatch", async () => {
    const local = migration(1);
    const database = new RecordingDatabase([{ ...local, filename: "0001_renamed.sql" }]);

    await expect(
      runMigrations({ database, loadMigrations: () => Promise.resolve([local]) }),
    ).rejects.toBeInstanceOf(MigrationFilenameMismatchError);
  });

  it("rejects an applied database version missing locally", async () => {
    const database = new RecordingDatabase([migration(2)]);

    await expect(
      runMigrations({ database, loadMigrations: () => Promise.resolve([migration(1)]) }),
    ).rejects.toBeInstanceOf(MissingLocalMigrationError);
  });

  it("rolls back when migration SQL execution fails", async () => {
    const local = migration(1);
    const database = new RecordingDatabase([], (sql) => sql === local.sql);

    await expect(
      runMigrations({ database, loadMigrations: () => Promise.resolve([local]) }),
    ).rejects.toBeInstanceOf(MigrationExecutionError);

    expect(database.calls.at(-2)?.sql).toBe("ROLLBACK");
  });

  it("rolls back when migration history insertion fails", async () => {
    const local = migration(1);
    const database = new RecordingDatabase([], (sql) => sql.includes("INSERT INTO"));

    await expect(
      runMigrations({ database, loadMigrations: () => Promise.resolve([local]) }),
    ).rejects.toBeInstanceOf(MigrationExecutionError);

    expect(database.calls.at(-2)?.sql).toBe("ROLLBACK");
  });

  it("releases the advisory lock after success", async () => {
    const database = new RecordingDatabase();

    await runMigrations({ database, loadMigrations: () => Promise.resolve([]) });

    expect(database.calls[0]?.sql).toContain("pg_try_advisory_lock");
    expect(database.calls.at(-1)?.sql).toContain("pg_advisory_unlock");
  });

  it("waits with an injected clock until the advisory lock becomes available", async () => {
    const { clock, sleeps } = createClock();
    const database = new RecordingDatabase([], () => false, [false, false, true]);

    await expect(
      runMigrations({
        database,
        loadMigrations: () => Promise.resolve([]),
        lock: { deadline: 25, retryDelayMs: 10, clock },
      }),
    ).resolves.toEqual({ appliedVersions: [] });

    expect(sleeps).toEqual([10, 10]);
    expect(callsMatching(database, "pg_try_advisory_lock")).toHaveLength(3);
  });

  it("fails safely when the advisory lock remains unavailable until its deadline", async () => {
    const { clock, sleeps } = createClock();
    const database = new RecordingDatabase([], () => false, [false, false, false]);

    await expect(
      runMigrations({
        database,
        loadMigrations: () => Promise.resolve([]),
        lock: { deadline: 25, retryDelayMs: 10, clock },
      }),
    ).rejects.toBeInstanceOf(MigrationLockTimeoutError);

    expect(sleeps).toEqual([10, 10, 5]);
    expect(callsMatching(database, "pg_advisory_unlock")).toHaveLength(0);
  });

  it("rejects an advisory-lock response without an acquired boolean", async () => {
    const database: MigrationDatabase = {
      query: () => Promise.resolve({ rows: [{}] }),
    };

    await expect(
      runMigrations({ database, loadMigrations: () => Promise.resolve([]) }),
    ).rejects.toBeInstanceOf(MigrationLockError);
  });

  it("releases the advisory lock after failure", async () => {
    const database = new RecordingDatabase();

    await expect(
      runMigrations({
        database,
        loadMigrations: () => Promise.reject(new Error("unsafe database detail")),
      }),
    ).rejects.toThrow();

    expect(database.calls.at(-1)?.sql).toContain("pg_advisory_unlock");
  });

  it("reports advisory unlock failure without leaking database details", async () => {
    const database = new RecordingDatabase([], (sql) => sql.includes("pg_advisory_unlock"));

    await expect(
      runMigrations({ database, loadMigrations: () => Promise.resolve([]) }),
    ).rejects.toBeInstanceOf(MigrationLockError);
  });

  it("does not expose database credentials from migration failures", async () => {
    const local = migration(1);
    const database = new RecordingDatabase([], (sql) => sql === local.sql);

    try {
      await runMigrations({ database, loadMigrations: () => Promise.resolve([local]) });
    } catch (error: unknown) {
      expect(String(error)).not.toContain("secret-password");
    }
  });
});

describe("migration startup lifecycle", () => {
  it.each([false, true])("closes the owner connection after success=%s", async (fail) => {
    const database = new RecordingDatabase([], (sql) => fail && sql.includes("CREATE SCHEMA"));
    const connect = vi.fn(() => Promise.resolve());
    const end = vi.fn(() => Promise.resolve());
    const connection: MigrationOwnerConnection = {
      connect,
      end,
      query: (sql, parameters) => database.query(sql, parameters),
    };

    const operation = runMigrationsWithOwner({
      connection,
      loadMigrations: () => Promise.resolve([]),
    });

    if (fail) {
      await expect(operation).rejects.toThrow();
    } else {
      await expect(operation).resolves.toEqual({ appliedVersions: [] });
    }
    expect(connect).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("sanitizes owner connection failures", async () => {
    const connection: MigrationOwnerConnection = {
      connect: () => Promise.reject(new Error("postgres://owner:secret-password@database/logs")),
      end: () => Promise.resolve(),
      query: () => Promise.resolve({ rows: [] }),
    };

    await expect(
      runMigrationsWithOwner({ connection, loadMigrations: () => Promise.resolve([]) }),
    ).rejects.toEqual(new MigrationConnectionError());
  });

  it("retries a transient owner connection with a fresh client and closes both clients", async () => {
    const { clock, sleeps } = createClock();
    const firstEnd = vi.fn(() => Promise.resolve());
    const secondEnd = vi.fn(() => Promise.resolve());
    const connections: MigrationOwnerConnection[] = [
      {
        connect: () => Promise.reject(retryableConnectionError()),
        end: firstEnd,
        query: () => Promise.resolve({ rows: [] }),
      },
      {
        connect: () => Promise.resolve(),
        end: secondEnd,
        query: (sql, parameters) => new RecordingDatabase().query(sql, parameters),
      },
    ];
    const createConnection = vi.fn(() => {
      const connection = connections.shift();
      if (connection === undefined) {
        throw new Error("Unexpected connection attempt.");
      }
      return connection;
    });

    await expect(
      runMigrationsWithOwnerRetry({
        createConnection,
        loadMigrations: () => Promise.resolve([]),
        timeoutMs: 100,
        retryDelayMs: 10,
        clock,
      }),
    ).resolves.toEqual({ appliedVersions: [] });

    expect(createConnection).toHaveBeenCalledTimes(2);
    expect(firstEnd).toHaveBeenCalledOnce();
    expect(secondEnd).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([10]);
  });

  it("closes every failed owner client and times out without exposing credentials", async () => {
    const { clock, sleeps } = createClock();
    const endFunctions: ReturnType<typeof vi.fn<() => Promise<void>>>[] = [];
    const createConnection = vi.fn((): MigrationOwnerConnection => {
      const end = vi.fn(() => Promise.resolve());
      endFunctions.push(end);
      return {
        connect: () => Promise.reject(retryableConnectionError()),
        end,
        query: () => Promise.resolve({ rows: [] }),
      };
    });

    const operation = runMigrationsWithOwnerRetry({
      createConnection,
      loadMigrations: () => Promise.resolve([]),
      timeoutMs: 25,
      retryDelayMs: 10,
      clock,
    });

    await expect(operation).rejects.toBeInstanceOf(MigrationOwnerStartupTimeoutError);
    expect(createConnection).toHaveBeenCalledTimes(3);
    expect(endFunctions).toHaveLength(3);
    expect(endFunctions.every((end) => end.mock.calls.length === 1)).toBe(true);
    expect(sleeps).toEqual([10, 10, 5]);
    try {
      await operation;
    } catch (error: unknown) {
      expect(String(error)).not.toContain("secret-password");
    }
  });

  it("does not start runtime resources after the owner startup deadline", async () => {
    const { clock } = createClock();
    const startRuntime = vi.fn(() => Promise.resolve("started"));

    await expect(
      migrateBeforeRuntime(
        () =>
          runMigrationsWithOwnerRetry({
            createConnection: () => ({
              connect: () => Promise.reject(retryableConnectionError()),
              end: () => Promise.resolve(),
              query: () => Promise.resolve({ rows: [] }),
            }),
            loadMigrations: () => Promise.resolve([]),
            timeoutMs: 10,
            retryDelayMs: 10,
            clock,
          }),
        startRuntime,
      ),
    ).rejects.toBeInstanceOf(MigrationOwnerStartupTimeoutError);

    expect(startRuntime).not.toHaveBeenCalled();
  });

  it("does not retry a deterministic checksum failure", async () => {
    const { clock } = createClock();
    const local = migration(1);
    const database = new RecordingDatabase([{ ...local, checksum: "f".repeat(64) }]);
    const end = vi.fn(() => Promise.resolve());
    const createConnection = vi.fn((): MigrationOwnerConnection => ({
      connect: () => Promise.resolve(),
      end,
      query: (sql, parameters) => database.query(sql, parameters),
    }));

    await expect(
      runMigrationsWithOwnerRetry({
        createConnection,
        loadMigrations: () => Promise.resolve([local]),
        timeoutMs: 100,
        retryDelayMs: 10,
        clock,
      }),
    ).rejects.toBeInstanceOf(MigrationChecksumMismatchError);

    expect(createConnection).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("does not retry deterministic migration execution failure", async () => {
    const { clock } = createClock();
    const local = migration(1);
    const database = new RecordingDatabase([], (sql) => sql === local.sql);
    const end = vi.fn(() => Promise.resolve());
    const createConnection = vi.fn((): MigrationOwnerConnection => ({
      connect: () => Promise.resolve(),
      end,
      query: (sql, parameters) => database.query(sql, parameters),
    }));

    await expect(
      runMigrationsWithOwnerRetry({
        createConnection,
        loadMigrations: () => Promise.resolve([local]),
        timeoutMs: 100,
        retryDelayMs: 10,
        clock,
      }),
    ).rejects.toBeInstanceOf(MigrationExecutionError);

    expect(createConnection).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("closes the owner connection and skips runtime startup after lock timeout", async () => {
    const { clock } = createClock();
    const database = new RecordingDatabase([], () => false, [false]);
    const end = vi.fn(() => Promise.resolve());
    const startRuntime = vi.fn(() => Promise.resolve("started"));

    await expect(
      migrateBeforeRuntime(
        () =>
          runMigrationsWithOwnerRetry({
            createConnection: () => ({
              connect: () => Promise.resolve(),
              end,
              query: (sql, parameters) => database.query(sql, parameters),
            }),
            loadMigrations: () => Promise.resolve([]),
            timeoutMs: 20,
            retryDelayMs: 10,
            clock,
          }),
        startRuntime,
      ),
    ).rejects.toBeInstanceOf(MigrationLockTimeoutError);

    expect(end).toHaveBeenCalledOnce();
    expect(startRuntime).not.toHaveBeenCalled();
  });

  it("does not start runtime resources after migration failure", async () => {
    const startRuntime = vi.fn(() => Promise.resolve("started"));

    await expect(
      migrateBeforeRuntime(() => Promise.reject(new Error("migration failed")), startRuntime),
    ).rejects.toThrow("migration failed");

    expect(startRuntime).not.toHaveBeenCalled();
  });
});
