import {
  MigrationChecksumMismatchError,
  MigrationConnectionError,
  MigrationError,
  MigrationExecutionError,
  MigrationFilenameMismatchError,
  MigrationHistoryReadError,
  MigrationInfrastructureError,
  MigrationLockError,
  MigrationLockTimeoutError,
  MigrationOwnerStartupTimeoutError,
  MissingLocalMigrationError,
} from "./migration-errors.js";
import type {
  AppliedMigration,
  MigrationClock,
  MigrationDatabase,
  MigrationFile,
  MigrationOwnerConnection,
  MigrationRunResult,
} from "./migration-types.js";

const ADVISORY_LOCK_NAMESPACE = 1_815_642_963;
const ADVISORY_LOCK_ID = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 100;

const TRY_ACQUIRE_LOCK_SQL = "SELECT pg_try_advisory_lock($1, $2) AS acquired";
const RELEASE_LOCK_SQL = "SELECT pg_advisory_unlock($1, $2) AS released";
const INITIALIZE_HISTORY_SQL = `
CREATE SCHEMA IF NOT EXISTS logstream_migrations AUTHORIZATION logstream_owner;
ALTER SCHEMA logstream_migrations OWNER TO logstream_owner;
REVOKE ALL ON SCHEMA logstream_migrations FROM PUBLIC;
REVOKE ALL ON SCHEMA logstream_migrations FROM logstream_runtime;

CREATE TABLE IF NOT EXISTS logstream_migrations.schema_migrations (
  version integer PRIMARY KEY CHECK (version > 0),
  filename text NOT NULL UNIQUE,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE logstream_migrations.schema_migrations OWNER TO logstream_owner;
REVOKE ALL ON TABLE logstream_migrations.schema_migrations FROM PUBLIC;
REVOKE ALL ON TABLE logstream_migrations.schema_migrations FROM logstream_runtime;
`;
const READ_HISTORY_SQL = `
SELECT version, filename, checksum
FROM logstream_migrations.schema_migrations
ORDER BY version
`;
const INSERT_HISTORY_SQL = `
INSERT INTO logstream_migrations.schema_migrations (version, filename, checksum)
VALUES ($1, $2, $3)
`;

export interface RunMigrationsOptions {
  readonly database: MigrationDatabase;
  readonly loadMigrations: () => Promise<readonly MigrationFile[]>;
  readonly lock?: MigrationLockOptions;
}

export interface RunMigrationsWithOwnerOptions {
  readonly connection: MigrationOwnerConnection;
  readonly loadMigrations: () => Promise<readonly MigrationFile[]>;
  readonly lock?: MigrationLockOptions;
}

export interface MigrationLockOptions {
  readonly deadline: number;
  readonly retryDelayMs: number;
  readonly clock?: MigrationClock;
}

export interface RunMigrationsWithOwnerRetryOptions {
  readonly createConnection: () => MigrationOwnerConnection;
  readonly loadMigrations: () => Promise<readonly MigrationFile[]>;
  readonly timeoutMs: number;
  readonly retryDelayMs: number;
  readonly clock?: MigrationClock;
  readonly afterMigrations?: (context: OwnerInitializationContext) => Promise<void>;
}

export interface OwnerInitializationContext {
  readonly database: MigrationDatabase;
  readonly deadline: number;
  readonly retryDelayMs: number;
  readonly clock: MigrationClock;
}

const systemClock: MigrationClock = {
  now: () => Date.now(),
  sleep: async (delayMs) =>
    new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    }),
  runWithTimeout: async <T>(operation: Promise<T>, timeoutMs: number): Promise<T> => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new MigrationOwnerStartupTimeoutError());
      }, timeoutMs);
    });

    try {
      return await Promise.race([operation, timeout]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  },
};

const RETRYABLE_CONNECTION_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "53300",
  "57P03",
]);

function isRetryableConnectionError(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some((nestedError) => isRetryableConnectionError(nestedError));
  }
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return typeof error.code === "string" && RETRYABLE_CONNECTION_CODES.has(error.code);
}

function isLockResult<Property extends "acquired" | "released">(
  value: unknown,
  property: Property,
): value is Record<Property, boolean> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    property in value &&
    typeof (value as Record<string, unknown>)[property] === "boolean"
  );
}

async function acquireLock(
  database: MigrationDatabase,
  lock: Required<MigrationLockOptions>,
): Promise<void> {
  for (;;) {
    if (lock.clock.now() >= lock.deadline) {
      throw new MigrationLockTimeoutError();
    }

    let result;
    try {
      result = await database.query(TRY_ACQUIRE_LOCK_SQL, [
        ADVISORY_LOCK_NAMESPACE,
        ADVISORY_LOCK_ID,
      ]);
    } catch {
      throw new MigrationLockError();
    }

    const row = result.rows[0];
    if (result.rows.length !== 1 || !isLockResult(row, "acquired")) {
      throw new MigrationLockError();
    }
    if (row.acquired) {
      return;
    }

    const remainingMs = lock.deadline - lock.clock.now();
    if (remainingMs <= 0) {
      throw new MigrationLockTimeoutError();
    }
    try {
      await lock.clock.sleep(Math.min(lock.retryDelayMs, remainingMs));
    } catch {
      throw new MigrationLockError();
    }
  }
}

async function releaseLock(database: MigrationDatabase): Promise<void> {
  try {
    const result = await database.query(RELEASE_LOCK_SQL, [
      ADVISORY_LOCK_NAMESPACE,
      ADVISORY_LOCK_ID,
    ]);
    const row = result.rows[0];
    if (result.rows.length !== 1 || !isLockResult(row, "released") || !row.released) {
      throw new MigrationLockError();
    }
  } catch (error: unknown) {
    if (error instanceof MigrationLockError) {
      throw error;
    }
    throw new MigrationLockError();
  }
}

function isAppliedMigration(value: unknown): value is AppliedMigration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return (
    "version" in value &&
    typeof value.version === "number" &&
    Number.isSafeInteger(value.version) &&
    "filename" in value &&
    typeof value.filename === "string" &&
    "checksum" in value &&
    typeof value.checksum === "string"
  );
}

async function initializeHistory(database: MigrationDatabase): Promise<void> {
  try {
    await database.query("BEGIN");
    await database.query(INITIALIZE_HISTORY_SQL);
    await database.query("COMMIT");
  } catch {
    try {
      await database.query("ROLLBACK");
    } catch {
      // The safe infrastructure error below remains the primary failure.
    }
    throw new MigrationInfrastructureError();
  }
}

async function readHistory(database: MigrationDatabase): Promise<readonly AppliedMigration[]> {
  try {
    const result = await database.query(READ_HISTORY_SQL);
    if (!result.rows.every(isAppliedMigration)) {
      throw new MigrationHistoryReadError();
    }
    return result.rows;
  } catch (error: unknown) {
    if (error instanceof MigrationHistoryReadError) {
      throw error;
    }
    throw new MigrationHistoryReadError();
  }
}

function findPendingMigrations(
  migrations: readonly MigrationFile[],
  appliedMigrations: readonly AppliedMigration[],
): readonly MigrationFile[] {
  const localByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const appliedVersions = new Set<number>();

  for (const applied of appliedMigrations) {
    const local = localByVersion.get(applied.version);
    if (local === undefined) {
      throw new MissingLocalMigrationError(applied.version);
    }
    if (local.filename !== applied.filename) {
      throw new MigrationFilenameMismatchError(applied.version);
    }
    if (local.checksum !== applied.checksum) {
      throw new MigrationChecksumMismatchError(applied.version);
    }
    appliedVersions.add(applied.version);
  }

  return migrations.filter((migration) => !appliedVersions.has(migration.version));
}

async function applyMigration(
  database: MigrationDatabase,
  migration: MigrationFile,
): Promise<void> {
  try {
    await database.query("BEGIN");
    await database.query(migration.sql);
    await database.query(INSERT_HISTORY_SQL, [
      migration.version,
      migration.filename,
      migration.checksum,
    ]);
    await database.query("COMMIT");
  } catch {
    try {
      await database.query("ROLLBACK");
    } catch {
      // The safe migration error below remains the primary failure.
    }
    throw new MigrationExecutionError(migration.version);
  }
}

export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationRunResult> {
  let primaryError: unknown;
  let result: MigrationRunResult | undefined;
  const clock = options.lock?.clock ?? systemClock;
  const lock: Required<MigrationLockOptions> = {
    deadline: options.lock?.deadline ?? clock.now() + DEFAULT_LOCK_TIMEOUT_MS,
    retryDelayMs: options.lock?.retryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS,
    clock,
  };

  await acquireLock(options.database, lock);

  try {
    const migrations = await options.loadMigrations();
    await initializeHistory(options.database);
    const appliedMigrations = await readHistory(options.database);
    const pendingMigrations = findPendingMigrations(migrations, appliedMigrations);
    const appliedVersions: number[] = [];

    for (const migration of pendingMigrations) {
      await applyMigration(options.database, migration);
      appliedVersions.push(migration.version);
    }

    result = { appliedVersions };
  } catch (error: unknown) {
    primaryError = error;
  }

  try {
    await releaseLock(options.database);
  } catch (error: unknown) {
    primaryError ??= error;
  }

  if (primaryError !== undefined) {
    if (primaryError instanceof MigrationError) {
      throw primaryError;
    }
    throw new MigrationHistoryReadError();
  }

  if (result === undefined) {
    throw new MigrationHistoryReadError();
  }

  return result;
}

export async function runMigrationsWithOwner(
  options: RunMigrationsWithOwnerOptions,
): Promise<MigrationRunResult> {
  let result: MigrationRunResult | undefined;
  let primaryError: unknown;

  try {
    await options.connection.connect();
    result = await runMigrations({
      database: options.connection,
      loadMigrations: options.loadMigrations,
      ...(options.lock === undefined ? {} : { lock: options.lock }),
    });
  } catch (error: unknown) {
    primaryError = error instanceof MigrationError ? error : new MigrationConnectionError();
  }

  try {
    await options.connection.end();
  } catch {
    primaryError ??= new MigrationConnectionError();
  }

  if (primaryError !== undefined) {
    if (primaryError instanceof Error) {
      throw primaryError;
    }
    throw new MigrationConnectionError();
  }
  if (result === undefined) {
    throw new MigrationConnectionError();
  }

  return result;
}

async function closeAbandonedConnection(connection: MigrationOwnerConnection): Promise<void> {
  try {
    await connection.end();
  } catch {
    // The safe startup failure remains primary; this connection will never be reused.
  }
}

export async function runMigrationsWithOwnerRetry(
  options: RunMigrationsWithOwnerRetryOptions,
): Promise<MigrationRunResult> {
  const clock = options.clock ?? systemClock;
  const deadline = clock.now() + options.timeoutMs;

  for (;;) {
    const remainingBeforeAttemptMs = deadline - clock.now();
    if (remainingBeforeAttemptMs <= 0) {
      throw new MigrationOwnerStartupTimeoutError();
    }

    let connection: MigrationOwnerConnection;
    try {
      connection = options.createConnection();
    } catch {
      throw new MigrationConnectionError();
    }

    try {
      await clock.runWithTimeout(connection.connect(), remainingBeforeAttemptMs);
    } catch (error: unknown) {
      await closeAbandonedConnection(connection);
      if (error instanceof MigrationOwnerStartupTimeoutError) {
        throw error;
      }
      if (!isRetryableConnectionError(error)) {
        throw new MigrationConnectionError();
      }

      const remainingAfterAttemptMs = deadline - clock.now();
      if (remainingAfterAttemptMs <= 0) {
        throw new MigrationOwnerStartupTimeoutError();
      }
      try {
        await clock.sleep(Math.min(options.retryDelayMs, remainingAfterAttemptMs));
      } catch {
        throw new MigrationConnectionError();
      }
      continue;
    }

    let result: MigrationRunResult | undefined;
    let primaryError: unknown;
    try {
      result = await runMigrations({
        database: connection,
        loadMigrations: options.loadMigrations,
        lock: {
          deadline,
          retryDelayMs: options.retryDelayMs,
          clock,
        },
      });
      await options.afterMigrations?.({
        database: connection,
        deadline,
        retryDelayMs: options.retryDelayMs,
        clock,
      });
    } catch (error: unknown) {
      primaryError = error instanceof MigrationError ? error : new MigrationConnectionError();
    }

    try {
      await connection.end();
    } catch {
      primaryError ??= new MigrationConnectionError();
    }

    if (primaryError !== undefined) {
      if (primaryError instanceof Error) {
        throw primaryError;
      }
      throw new MigrationConnectionError();
    }
    if (result === undefined) {
      throw new MigrationConnectionError();
    }
    return result;
  }
}

export async function migrateBeforeRuntime<T>(
  migrate: () => Promise<unknown>,
  startRuntime: () => Promise<T>,
): Promise<T> {
  await migrate();
  return startRuntime();
}
