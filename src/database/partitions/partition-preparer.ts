import type { MigrationClock, MigrationDatabase } from "../migrations/migration-types.js";
import {
  assertDailyPartition,
  type DailyPartition,
  InvalidPartitionPlanError,
} from "./partition-plan.js";

const PARTITION_LOCK_NAMESPACE = 1_815_642_963;
const PARTITION_LOCK_ID = 2;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 100;
const TRY_LOCK_SQL = "SELECT pg_try_advisory_lock($1, $2) AS acquired";
const UNLOCK_SQL = "SELECT pg_advisory_unlock($1, $2) AS released";
const READ_PARTITIONS_SQL = `
SELECT child.relname AS name
FROM pg_inherits AS inheritance
JOIN pg_class AS parent ON parent.oid = inheritance.inhparent
JOIN pg_namespace AS parent_namespace ON parent_namespace.oid = parent.relnamespace
JOIN pg_class AS child ON child.oid = inheritance.inhrelid
WHERE parent_namespace.nspname = 'logstream'
  AND parent.relname = 'logs'
`;
const OVERLAP_SQL = `
SELECT EXISTS (
  SELECT 1
  FROM logstream.logs_default
  WHERE timestamp >= $1::timestamptz
    AND timestamp < $2::timestamptz
) AS has_overlap
`;
const MOVE_OVERLAP_SQL_PREFIX = `
WITH moved_rows AS (
  DELETE FROM logstream.logs_default
  WHERE timestamp >= $1::timestamptz
    AND timestamp < $2::timestamptz
  RETURNING timestamp, id, level, service, message, attributes, attributes_search, created_at
)
INSERT INTO logstream.`;
const MOVE_OVERLAP_SQL_SUFFIX = `
  (timestamp, id, level, service, message, attributes, attributes_search, created_at)
SELECT timestamp, id, level, service, message, attributes, attributes_search, created_at
FROM moved_rows
`;

export class PartitionPreparationError extends Error {
  public constructor() {
    super("Required database partitions could not be prepared.");
    this.name = "PartitionPreparationError";
  }
}

export class PartitionLockTimeoutError extends PartitionPreparationError {
  public constructor() {
    super();
    this.name = "PartitionLockTimeoutError";
  }
}

export interface PartitionPreparerOptions {
  readonly database: MigrationDatabase;
  readonly partitions: readonly DailyPartition[];
  readonly deadline?: number;
  readonly retryDelayMs?: number;
  readonly clock?: MigrationClock;
}

export interface PartitionStructuralSql {
  readonly create: string;
  readonly attach: string;
}

const systemClock: MigrationClock = {
  now: () => Date.now(),
  sleep: async (delayMs) =>
    new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    }),
  runWithTimeout: async <T>(operation: Promise<T>): Promise<T> => operation,
};

function isBooleanRow(
  value: unknown,
  property: "acquired" | "released" | "has_overlap",
): value is Record<string, boolean> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    property in value &&
    typeof (value as Record<string, unknown>)[property] === "boolean"
  );
}

function readPartitionName(value: unknown): string | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "name" in value &&
    typeof value.name === "string"
  ) {
    return value.name;
  }
  return undefined;
}

export function buildPartitionStructuralSql(partition: DailyPartition): PartitionStructuralSql {
  assertDailyPartition(partition);
  const constraint = `${partition.name}_timestamp_bounds`;
  return {
    create: `
CREATE TABLE logstream.${partition.name} (
  LIKE logstream.logs INCLUDING DEFAULTS INCLUDING CONSTRAINTS
);
ALTER TABLE logstream.${partition.name} OWNER TO logstream_owner;
ALTER TABLE logstream.${partition.name}
  ADD CONSTRAINT ${constraint}
  CHECK (
    timestamp >= TIMESTAMPTZ '${partition.start}'
    AND timestamp < TIMESTAMPTZ '${partition.end}'
  ) NOT VALID;
ALTER TABLE logstream.${partition.name} VALIDATE CONSTRAINT ${constraint};
REVOKE ALL ON TABLE logstream.${partition.name} FROM PUBLIC;
REVOKE ALL ON TABLE logstream.${partition.name} FROM logstream_runtime;
`,
    attach: `ALTER TABLE logstream.logs ATTACH PARTITION logstream.${partition.name} FOR VALUES FROM (TIMESTAMPTZ '${partition.start}') TO (TIMESTAMPTZ '${partition.end}')`,
  };
}

async function acquireLock(
  database: MigrationDatabase,
  deadline: number,
  retryDelayMs: number,
  clock: MigrationClock,
): Promise<void> {
  for (;;) {
    if (clock.now() >= deadline) {
      throw new PartitionLockTimeoutError();
    }
    let result;
    try {
      result = await database.query(TRY_LOCK_SQL, [PARTITION_LOCK_NAMESPACE, PARTITION_LOCK_ID]);
    } catch {
      throw new PartitionPreparationError();
    }
    const row = result.rows[0];
    if (result.rows.length !== 1 || !isBooleanRow(row, "acquired")) {
      throw new PartitionPreparationError();
    }
    if (row["acquired"]) {
      return;
    }
    const remainingMs = deadline - clock.now();
    if (remainingMs <= 0) {
      throw new PartitionLockTimeoutError();
    }
    await clock.sleep(Math.min(retryDelayMs, remainingMs));
  }
}

async function releaseLock(database: MigrationDatabase): Promise<void> {
  try {
    const result = await database.query(UNLOCK_SQL, [PARTITION_LOCK_NAMESPACE, PARTITION_LOCK_ID]);
    const row = result.rows[0];
    if (result.rows.length !== 1 || !isBooleanRow(row, "released") || !row["released"]) {
      throw new PartitionPreparationError();
    }
  } catch (error: unknown) {
    if (error instanceof PartitionPreparationError) {
      throw error;
    }
    throw new PartitionPreparationError();
  }
}

async function preparePartition(
  database: MigrationDatabase,
  partition: DailyPartition,
): Promise<void> {
  const structuralSql = buildPartitionStructuralSql(partition);
  try {
    await database.query("BEGIN");
    await database.query("LOCK TABLE logstream.logs_default IN ACCESS EXCLUSIVE MODE");
    await database.query(structuralSql.create);
    const overlap = await database.query(OVERLAP_SQL, [partition.start, partition.end]);
    const overlapRow = overlap.rows[0];
    if (overlap.rows.length !== 1 || !isBooleanRow(overlapRow, "has_overlap")) {
      throw new PartitionPreparationError();
    }
    if (overlapRow["has_overlap"]) {
      await database.query(
        `${MOVE_OVERLAP_SQL_PREFIX}${partition.name}${MOVE_OVERLAP_SQL_SUFFIX}`,
        [partition.start, partition.end],
      );
    }
    await database.query(structuralSql.attach);
    await database.query("COMMIT");
  } catch {
    try {
      await database.query("ROLLBACK");
    } catch {
      // The safe preparation error remains primary.
    }
    throw new PartitionPreparationError();
  }
}

export async function preparePartitions(options: PartitionPreparerOptions): Promise<void> {
  const clock = options.clock ?? systemClock;
  const deadline = options.deadline ?? clock.now() + DEFAULT_LOCK_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const partitions = options.partitions.toSorted((left, right) =>
    left.start.localeCompare(right.start),
  );
  const names = new Set<string>();
  for (const partition of partitions) {
    assertDailyPartition(partition);
    if (names.has(partition.name)) {
      throw new InvalidPartitionPlanError();
    }
    names.add(partition.name);
  }

  await acquireLock(options.database, deadline, retryDelayMs, clock);
  let primaryError: unknown;
  try {
    const result = await options.database.query(READ_PARTITIONS_SQL);
    const existing = new Set<string>();
    for (const row of result.rows) {
      const name = readPartitionName(row);
      if (name === undefined) {
        throw new PartitionPreparationError();
      }
      existing.add(name);
    }

    for (const partition of partitions) {
      if (!existing.has(partition.name)) {
        await preparePartition(options.database, partition);
      }
    }
  } catch (error: unknown) {
    primaryError =
      error instanceof PartitionPreparationError || error instanceof InvalidPartitionPlanError
        ? error
        : new PartitionPreparationError();
  }

  try {
    await releaseLock(options.database);
  } catch (error: unknown) {
    primaryError ??= error;
  }
  if (primaryError !== undefined) {
    if (primaryError instanceof Error) {
      throw primaryError;
    }
    throw new PartitionPreparationError();
  }
}
