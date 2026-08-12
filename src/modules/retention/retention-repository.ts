import { InternalDatabaseError, translateDatabaseError } from "../../database/database-errors.js";
import {
  assertDailyPartition,
  type DailyPartition,
} from "../../database/partitions/partition-plan.js";
import type { CanonicalUtcTimestamp } from "../../domain/log-entry.js";
import { parseCanonicalTimestamp } from "../../domain/timestamp.js";

const MAINTENANCE_LOCK_NAMESPACE = 1_815_642_963;
const MAINTENANCE_LOCK_ID = 2;
const PARTITION_DROP_CALL_LIMIT = 32;
const DEFAULT_DELETE_BATCH_SIZE = 1_000;
const DEFAULT_DELETE_CALL_LIMIT = 10;
const MILLISECONDS_PER_DAY = 86_400_000;

const TRY_LOCK_SQL = "SELECT pg_try_advisory_lock($1, $2) AS acquired";
const UNLOCK_SQL = "SELECT pg_advisory_unlock($1, $2) AS released";
const ENSURE_PARTITION_SQL = "SELECT logstream.ensure_log_partition($1::timestamptz) AS created";
const DROP_PARTITION_SQL =
  "SELECT logstream.drop_one_expired_log_partition($1::timestamptz) AS dropped";
const DELETE_DEFAULT_SQL =
  "SELECT logstream.delete_expired_default_logs($1::timestamptz, $2::integer) AS deleted";

export type RetentionRunStatus = "completed" | "skipped" | "aborted";

export interface RetentionRunRequest {
  readonly referenceTime: CanonicalUtcTimestamp;
  readonly cutoff: CanonicalUtcTimestamp;
  readonly partitions: readonly DailyPartition[];
  readonly signal: AbortSignal;
}

export interface RetentionRunResult {
  readonly status: RetentionRunStatus;
  readonly partitionEnsureCalls: number;
  readonly partitionsCreated: number;
  readonly partitionDropCalls: number;
  readonly partitionsDropped: number;
  readonly defaultCleanupCalls: number;
  readonly defaultRowsDeleted: number;
  readonly partitionDropBudgetReached: boolean;
  readonly defaultDeleteBudgetReached: boolean;
}

export interface RetentionDatabaseResult {
  readonly rows: readonly unknown[];
}

export interface RetentionDatabaseClient {
  query(sql: string, parameters?: unknown[]): Promise<RetentionDatabaseResult>;
  release(destroy?: boolean): void;
}

export interface RetentionDatabasePool {
  connect(): Promise<RetentionDatabaseClient>;
}

export interface RetentionRepository {
  run(request: RetentionRunRequest): Promise<RetentionRunResult>;
}

interface ValidatedRetentionRequest {
  readonly referenceTime: CanonicalUtcTimestamp;
  readonly cutoff: CanonicalUtcTimestamp;
  readonly partitions: readonly DailyPartition[];
  readonly signal: AbortSignal;
}

interface MutableRunResult {
  status: RetentionRunStatus;
  partitionEnsureCalls: number;
  partitionsCreated: number;
  partitionDropCalls: number;
  partitionsDropped: number;
  defaultCleanupCalls: number;
  defaultRowsDeleted: number;
  partitionDropBudgetReached: boolean;
  defaultDeleteBudgetReached: boolean;
}

function emptyResult(status: RetentionRunStatus): RetentionRunResult {
  return {
    status,
    partitionEnsureCalls: 0,
    partitionsCreated: 0,
    partitionDropCalls: 0,
    partitionsDropped: 0,
    defaultCleanupCalls: 0,
    defaultRowsDeleted: 0,
    partitionDropBudgetReached: false,
    defaultDeleteBudgetReached: false,
  };
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOwnEnumerableDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor?.enumerable !== true || !("value" in descriptor)) {
    throw new InternalDatabaseError();
  }

  return descriptor.value;
}

function readCanonicalTimestamp(value: unknown): CanonicalUtcTimestamp {
  if (typeof value !== "string") {
    throw new InternalDatabaseError();
  }

  const parsed = parseCanonicalTimestamp(value);
  if (
    !parsed.ok ||
    parsed.value.canonical !== value ||
    !Number.isFinite(parsed.value.wholeSecondMs)
  ) {
    throw new InternalDatabaseError();
  }

  return parsed.value.canonical;
}

function copyPartition(value: unknown): DailyPartition {
  if (!isObject(value)) {
    throw new InternalDatabaseError();
  }

  const name = readOwnEnumerableDataProperty(value, "name");
  const start = readOwnEnumerableDataProperty(value, "start");
  const end = readOwnEnumerableDataProperty(value, "end");
  if (typeof name !== "string" || typeof start !== "string" || typeof end !== "string") {
    throw new InternalDatabaseError();
  }

  const partition = Object.assign(Object.create(null) as object, {
    name,
    start,
    end,
  }) as DailyPartition;
  try {
    assertDailyPartition(partition);
  } catch {
    throw new InternalDatabaseError();
  }

  return partition;
}

function expectedPartitionStart(referenceTime: CanonicalUtcTimestamp, offset: number): string {
  const parsed = parseCanonicalTimestamp(referenceTime);
  if (!parsed.ok) {
    throw new InternalDatabaseError();
  }

  const utcDay =
    Math.floor(parsed.value.wholeSecondMs / MILLISECONDS_PER_DAY) * MILLISECONDS_PER_DAY;
  return new Date(utcDay + offset * MILLISECONDS_PER_DAY).toISOString();
}

function validateRequest(request: RetentionRunRequest): ValidatedRetentionRequest {
  if (!isObject(request)) {
    throw new InternalDatabaseError();
  }

  const referenceTime = readCanonicalTimestamp(
    readOwnEnumerableDataProperty(request, "referenceTime"),
  );
  const cutoff = readCanonicalTimestamp(readOwnEnumerableDataProperty(request, "cutoff"));
  const partitionsValue = readOwnEnumerableDataProperty(request, "partitions");
  const signalValue = readOwnEnumerableDataProperty(request, "signal");

  if (!Array.isArray(partitionsValue) || partitionsValue.length !== 3) {
    throw new InternalDatabaseError();
  }
  if (!(signalValue instanceof AbortSignal)) {
    throw new InternalDatabaseError();
  }

  const partitions = partitionsValue.map((partition) => copyPartition(partition));
  const names = new Set(partitions.map((partition) => partition.name));
  if (names.size !== 3) {
    throw new InternalDatabaseError();
  }

  for (const [index, partition] of partitions.entries()) {
    if (partition.start !== expectedPartitionStart(referenceTime, index)) {
      throw new InternalDatabaseError();
    }
  }

  return { referenceTime, cutoff, partitions, signal: signalValue };
}

function readSingleBoolean(result: RetentionDatabaseResult, key: string): boolean {
  if (!isObject(result)) {
    throw new InternalDatabaseError();
  }

  const rows = readOwnEnumerableDataProperty(result, "rows");
  if (!Array.isArray(rows) || rows.length !== 1 || !isObject(rows[0])) {
    throw new InternalDatabaseError();
  }

  const value = readOwnEnumerableDataProperty(rows[0], key);
  if (typeof value !== "boolean") {
    throw new InternalDatabaseError();
  }

  return value;
}

function readSingleCount(result: RetentionDatabaseResult, key: string): number {
  if (!isObject(result)) {
    throw new InternalDatabaseError();
  }

  const rows = readOwnEnumerableDataProperty(result, "rows");
  if (!Array.isArray(rows) || rows.length !== 1 || !isObject(rows[0])) {
    throw new InternalDatabaseError();
  }

  const value = readOwnEnumerableDataProperty(rows[0], key);
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    throw new InternalDatabaseError();
  }

  return value;
}

function releaseClient(client: RetentionDatabaseClient, destroy: boolean): void {
  if (destroy) {
    client.release(true);
    return;
  }

  client.release();
}

function toSafeDatabaseError(error: unknown): Error {
  return error instanceof InternalDatabaseError ? error : translateDatabaseError(error);
}

async function executeMaintenance(
  client: RetentionDatabaseClient,
  request: ValidatedRetentionRequest,
): Promise<RetentionRunResult> {
  const result: MutableRunResult = { ...emptyResult("completed") };

  for (const partition of request.partitions) {
    if (request.signal.aborted) {
      result.status = "aborted";
      return result;
    }

    const queryResult = await client.query(ENSURE_PARTITION_SQL, [partition.start]);
    const created = readSingleBoolean(queryResult, "created");
    result.partitionEnsureCalls += 1;
    if (created) {
      result.partitionsCreated += 1;
    }
  }

  for (let call = 1; call <= PARTITION_DROP_CALL_LIMIT; call += 1) {
    if (request.signal.aborted) {
      result.status = "aborted";
      return result;
    }

    const queryResult = await client.query(DROP_PARTITION_SQL, [request.cutoff]);
    const dropped = readSingleBoolean(queryResult, "dropped");
    result.partitionDropCalls += 1;
    if (!dropped) {
      break;
    }

    result.partitionsDropped += 1;
    if (call === PARTITION_DROP_CALL_LIMIT) {
      result.partitionDropBudgetReached = true;
    }
  }

  for (let call = 1; call <= DEFAULT_DELETE_CALL_LIMIT; call += 1) {
    if (request.signal.aborted) {
      result.status = "aborted";
      return result;
    }

    const queryResult = await client.query(DELETE_DEFAULT_SQL, [
      request.cutoff,
      DEFAULT_DELETE_BATCH_SIZE,
    ]);
    const deleted = readSingleCount(queryResult, "deleted");
    if (deleted > DEFAULT_DELETE_BATCH_SIZE) {
      throw new InternalDatabaseError();
    }
    result.defaultCleanupCalls += 1;
    result.defaultRowsDeleted += deleted;
    if (deleted < DEFAULT_DELETE_BATCH_SIZE) {
      return result;
    }
    if (call === DEFAULT_DELETE_CALL_LIMIT) {
      result.defaultDeleteBudgetReached = true;
    }
  }

  return result;
}

export function createRetentionRepository(pool: RetentionDatabasePool): RetentionRepository {
  return {
    run: async (untrustedRequest) => {
      let request: ValidatedRetentionRequest;
      try {
        request = validateRequest(untrustedRequest);
      } catch (error: unknown) {
        throw toSafeDatabaseError(error);
      }

      if (request.signal.aborted) {
        return emptyResult("aborted");
      }

      let client: RetentionDatabaseClient;
      try {
        client = await pool.connect();
      } catch (error: unknown) {
        throw translateDatabaseError(error);
      }

      let primaryError: Error | undefined;
      let result: RetentionRunResult | undefined;
      let lockAcquired = false;
      let destroyClient = false;

      try {
        const lockResult = await client.query(TRY_LOCK_SQL, [
          MAINTENANCE_LOCK_NAMESPACE,
          MAINTENANCE_LOCK_ID,
        ]);
        lockAcquired = readSingleBoolean(lockResult, "acquired");
        if (!lockAcquired) {
          result = emptyResult("skipped");
        } else {
          result = await executeMaintenance(client, request);
        }
      } catch (error: unknown) {
        primaryError = toSafeDatabaseError(error);
        if (!lockAcquired) {
          destroyClient = true;
        }
      }

      if (lockAcquired) {
        try {
          const unlockResult = await client.query(UNLOCK_SQL, [
            MAINTENANCE_LOCK_NAMESPACE,
            MAINTENANCE_LOCK_ID,
          ]);
          if (!readSingleBoolean(unlockResult, "released")) {
            throw new InternalDatabaseError();
          }
        } catch (error: unknown) {
          destroyClient = true;
          primaryError ??= toSafeDatabaseError(error);
        }
      }

      try {
        releaseClient(client, destroyClient);
      } catch (error: unknown) {
        primaryError ??= translateDatabaseError(error);
      }

      if (primaryError !== undefined) {
        throw primaryError;
      }
      if (result === undefined) {
        throw new InternalDatabaseError();
      }

      return result;
    },
  };
}
