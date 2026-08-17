import { translateDatabaseError } from "../../database/database-errors.js";
import { normalizeAttributes } from "../../domain/attribute-normalizer.js";
import type { LogInsertionRecord } from "../../domain/log-entry.js";

export interface IngestionDatabasePool {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

export interface IngestionRepository {
  insert(records: readonly LogInsertionRecord[]): Promise<void>;
}

const INSERT_LOGS_AND_AGGREGATES_SQL = `
WITH inserted AS (
  INSERT INTO logstream.logs (
    timestamp,
    id,
    level,
    service,
    message,
    attributes,
    attributes_search
  )
  SELECT
    batch.timestamp,
    batch.id,
    batch.level,
    batch.service,
    batch.message,
    batch.attributes,
    batch.attributes_search
  FROM UNNEST(
    $1::timestamptz[],
    $2::uuid[],
    $3::text[],
    $4::text[],
    $5::text[],
    $6::jsonb[],
    $7::jsonb[]
  ) AS batch(timestamp, id, level, service, message, attributes, attributes_search)
)
INSERT INTO logstream.log_minute_aggregates (
  bucket_start,
  service,
  level,
  count
)
SELECT
  agg.bucket_start,
  agg.service,
  agg.level,
  agg.count
FROM UNNEST(
  $8::timestamptz[],
  $9::text[],
  $10::text[],
  $11::bigint[]
) AS agg(bucket_start, service, level, count)
ON CONFLICT (bucket_start, service, level)
DO UPDATE SET count = logstream.log_minute_aggregates.count + EXCLUDED.count;
`;

interface AggregateGroup {
  readonly bucketStart: string;
  readonly service: string;
  readonly level: string;
  count: number;
}

const MINUTE_MS = 60_000;

function serializeJsonb(value: object): string {
  return JSON.stringify(value);
}

function toMinuteBucketIso(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  const bucketStartMs = Math.floor(parsed / MINUTE_MS) * MINUTE_MS;
  return new Date(bucketStartMs).toISOString();
}

function groupRecordsForAggregation(records: readonly LogInsertionRecord[]): AggregateGroup[] {
  const groups = new Map<string, AggregateGroup>();

  for (const record of records) {
    const bucketStart = toMinuteBucketIso(record.timestamp);
    const key = `${bucketStart}\u0000${record.service}\u0000${record.level}`;
    const existing = groups.get(key);

    if (existing !== undefined) {
      existing.count += 1;
      continue;
    }

    groups.set(key, {
      bucketStart,
      service: record.service,
      level: record.level,
      count: 1,
    });
  }

  return Array.from(groups.values()).sort(
    (left, right) =>
      left.bucketStart.localeCompare(right.bucketStart) ||
      left.service.localeCompare(right.service) ||
      left.level.localeCompare(right.level),
  );
}

function buildInsertParameters(records: readonly LogInsertionRecord[]): unknown[] {
  const count = records.length;
  const timestamps = new Array<LogInsertionRecord["timestamp"]>(count);
  const ids = new Array<LogInsertionRecord["id"]>(count);
  const levels = new Array<LogInsertionRecord["level"]>(count);
  const services = new Array<string>(count);
  const messages = new Array<string>(count);
  const attributes = new Array<string>(count);
  const attributesSearch = new Array<string>(count);

  for (let index = 0; index < count; index += 1) {
    const record = records[index];
    if (record === undefined) {
      continue;
    }
    timestamps[index] = record.timestamp;
    ids[index] = record.id;
    levels[index] = record.level;
    services[index] = record.service;
    messages[index] = record.message;
    attributes[index] = serializeJsonb(record.attributes);
    attributesSearch[index] = serializeJsonb(
      record.attributesSearch ?? normalizeAttributes(record.attributes),
    );
  }

  const groups = groupRecordsForAggregation(records);
  const groupCount = groups.length;
  const aggBucketStarts = new Array<string>(groupCount);
  const aggServices = new Array<string>(groupCount);
  const aggLevels = new Array<string>(groupCount);
  const aggCounts = new Array<number>(groupCount);

  for (let index = 0; index < groupCount; index += 1) {
    const group = groups[index];
    if (group === undefined) {
      continue;
    }
    aggBucketStarts[index] = group.bucketStart;
    aggServices[index] = group.service;
    aggLevels[index] = group.level;
    aggCounts[index] = group.count;
  }

  return [
    timestamps,
    ids,
    levels,
    services,
    messages,
    attributes,
    attributesSearch,
    aggBucketStarts,
    aggServices,
    aggLevels,
    aggCounts,
  ];
}

export function createIngestionRepository(pool: IngestionDatabasePool): IngestionRepository {
  return {
    insert: async (records) => {
      if (records.length === 0) {
        return;
      }

      let parameters: unknown[];
      try {
        parameters = buildInsertParameters(records);
      } catch (error: unknown) {
        throw translateDatabaseError(error);
      }

      try {
        // A single INSERT statement with CTE is an atomic PostgreSQL transaction.
        await pool.query(INSERT_LOGS_AND_AGGREGATES_SQL, parameters);
      } catch (error: unknown) {
        throw translateDatabaseError(error);
      }
    },
  };
}
