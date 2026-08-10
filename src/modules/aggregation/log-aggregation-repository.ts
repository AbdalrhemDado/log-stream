import { InternalDatabaseError, translateDatabaseError } from "../../database/database-errors.js";
import { LOG_LEVELS, type CanonicalUtcTimestamp, type LogLevel } from "../../domain/log-entry.js";
import { parseCanonicalTimestamp } from "../../domain/timestamp.js";
import { buildLogPredicate } from "../query/log-predicate-builder.js";
import type {
  AggregationBucket,
  AggregationGroupBy,
  ParsedLogAggregationQuery,
} from "./aggregation-parameter-parser.js";

const BUCKET_INTERVAL_SQL = {
  "1m": "INTERVAL '1 minute'",
  "5m": "INTERVAL '5 minutes'",
  "1h": "INTERVAL '1 hour'",
  "1d": "INTERVAL '1 day'",
} as const satisfies Readonly<Record<AggregationBucket, string>>;

const GROUP_EXPRESSION_SQL = {
  service: "logs.service",
  level: "logs.level",
} as const satisfies Readonly<Record<AggregationGroupBy, string>>;

const FIXED_EPOCH_ORIGIN_SQL = "TIMESTAMPTZ '1970-01-01 00:00:00+00'";
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;
const MAX_SAFE_COUNT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_SAFE_COUNT_DIGITS = String(Number.MAX_SAFE_INTEGER).length;

export interface LogAggregationBucket {
  readonly start: CanonicalUtcTimestamp;
  readonly group: string | null;
  readonly count: number;
}

export interface LogAggregationDatabaseResult {
  readonly rows: readonly unknown[];
}

export interface LogAggregationDatabasePool {
  query(sql: string, parameters?: unknown[]): Promise<LogAggregationDatabaseResult>;
}

export interface LogAggregationRepository {
  aggregate(request: ParsedLogAggregationQuery): Promise<readonly LogAggregationBucket[]>;
}

function readBucketInterval(bucket: AggregationBucket): string {
  if (typeof bucket !== "string" || !Object.hasOwn(BUCKET_INTERVAL_SQL, bucket)) {
    throw new InternalDatabaseError();
  }

  return BUCKET_INTERVAL_SQL[bucket];
}

function readGroupExpression(groupBy: AggregationGroupBy): string {
  if (typeof groupBy !== "string" || !Object.hasOwn(GROUP_EXPRESSION_SQL, groupBy)) {
    throw new InternalDatabaseError();
  }

  return GROUP_EXPRESSION_SQL[groupBy];
}

function buildAggregationQuery(request: ParsedLogAggregationQuery): {
  readonly text: string;
  readonly values: unknown[];
} {
  const interval = readBucketInterval(request.bucket);
  const groupExpression =
    request.groupBy === undefined ? undefined : readGroupExpression(request.groupBy);
  const predicate = buildLogPredicate(request.filters);
  const groupValueSql = groupExpression ?? "NULL::text";
  const groupBySql = groupExpression === undefined ? "GROUP BY 1" : "GROUP BY 1, 2";
  const groupOrderSql = groupExpression === undefined ? "" : ", aggregation.group_value ASC";

  return {
    text: `
SELECT
  to_char(
    aggregation.bucket_start AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) AS start,
  aggregation.group_value AS "group",
  aggregation.count::text AS count
FROM (
  SELECT
    date_bin(
      ${interval},
      logs."timestamp",
      ${FIXED_EPOCH_ORIGIN_SQL}
    ) AS bucket_start,
    ${groupValueSql} AS group_value,
    COUNT(*) AS count
  FROM logstream.logs AS logs
  WHERE ${predicate.text}
  ${groupBySql}
) AS aggregation
ORDER BY aggregation.bucket_start ASC${groupOrderSql}
`,
    values: [...predicate.values],
  };
}

function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOwnDataProperty(row: object, key: "start" | "group" | "count"): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);

  if (descriptor?.enumerable !== true || !("value" in descriptor)) {
    throw new InternalDatabaseError();
  }

  return descriptor.value;
}

function isLogLevel(value: string): value is LogLevel {
  return LOG_LEVELS.some((level) => level === value);
}

function mapCount(value: unknown): number {
  if (
    typeof value !== "string" ||
    value.length > MAX_SAFE_COUNT_DIGITS ||
    !POSITIVE_INTEGER_PATTERN.test(value)
  ) {
    throw new InternalDatabaseError();
  }

  const count = BigInt(value);
  if (count > MAX_SAFE_COUNT) {
    throw new InternalDatabaseError();
  }

  const converted = Number(count);
  if (!Number.isSafeInteger(converted)) {
    throw new InternalDatabaseError();
  }

  return converted;
}

function mapGroup(value: unknown, groupBy: AggregationGroupBy | undefined): string | null {
  if (groupBy === undefined) {
    if (value !== null) {
      throw new InternalDatabaseError();
    }

    return null;
  }

  if (typeof value !== "string") {
    throw new InternalDatabaseError();
  }

  if (groupBy === "level" && !isLogLevel(value)) {
    throw new InternalDatabaseError();
  }

  return value;
}

function mapRow(value: unknown, groupBy: AggregationGroupBy | undefined): LogAggregationBucket {
  if (!isRecord(value)) {
    throw new InternalDatabaseError();
  }

  const start = readOwnDataProperty(value, "start");
  const group = readOwnDataProperty(value, "group");
  const count = readOwnDataProperty(value, "count");

  if (typeof start !== "string") {
    throw new InternalDatabaseError();
  }

  const parsedStart = parseCanonicalTimestamp(start);
  if (!parsedStart.ok) {
    throw new InternalDatabaseError();
  }

  return {
    start: parsedStart.value.canonical,
    group: mapGroup(group, groupBy),
    count: mapCount(count),
  };
}

export function createLogAggregationRepository(
  pool: LogAggregationDatabasePool,
): LogAggregationRepository {
  return {
    aggregate: async (request) => {
      let query: ReturnType<typeof buildAggregationQuery>;

      try {
        query = buildAggregationQuery(request);
      } catch (error: unknown) {
        if (error instanceof InternalDatabaseError) {
          throw error;
        }

        throw new InternalDatabaseError();
      }

      let result: LogAggregationDatabaseResult;
      try {
        result = await pool.query(query.text, query.values);
      } catch (error: unknown) {
        throw translateDatabaseError(error);
      }

      try {
        if (!Array.isArray(result.rows)) {
          throw new InternalDatabaseError();
        }

        return result.rows.map((row) => mapRow(row, request.groupBy));
      } catch (error: unknown) {
        if (error instanceof InternalDatabaseError) {
          throw error;
        }

        throw new InternalDatabaseError();
      }
    },
  };
}
