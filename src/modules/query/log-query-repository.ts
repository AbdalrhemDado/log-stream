import { InternalDatabaseError, translateDatabaseError } from "../../database/database-errors.js";
import type { AttributeValue, OriginalAttributes } from "../../domain/attributes.js";
import {
  LOG_LEVELS,
  type ApiLogResponseItem,
  type LogId,
  type LogLevel,
} from "../../domain/log-entry.js";
import { parseCanonicalTimestamp } from "../../domain/timestamp.js";
import type { LogCursorPosition } from "./cursor-codec.js";
import { buildLogPredicate } from "./log-predicate-builder.js";
import type { LogFilters } from "./query-parameter-parser.js";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface LogQueryDatabaseResult {
  readonly rows: readonly unknown[];
}

export interface LogQueryDatabasePool {
  query(sql: string, parameters?: unknown[]): Promise<LogQueryDatabaseResult>;
}

export interface LogQueryPageRequest {
  readonly filters: LogFilters;
  readonly limit: number;
  readonly cursor?: LogCursorPosition;
}

export interface LogQueryRepository {
  findPage(request: LogQueryPageRequest): Promise<readonly ApiLogResponseItem[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && LOG_LEVELS.some((level) => level === value);
}

function isAttributeValue(value: unknown): value is AttributeValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function mapAttributes(value: unknown): OriginalAttributes {
  if (!isRecord(value)) {
    throw new InternalDatabaseError();
  }

  const attributes = Object.create(null) as Record<string, AttributeValue>;

  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || !("value" in descriptor)) {
      throw new InternalDatabaseError();
    }

    if (!isAttributeValue(descriptor.value)) {
      throw new InternalDatabaseError();
    }

    attributes[key] = descriptor.value;
  }

  return attributes as OriginalAttributes;
}

function mapRow(value: unknown): ApiLogResponseItem {
  if (!isRecord(value)) {
    throw new InternalDatabaseError();
  }

  const id = value["id"];
  const timestamp = value["timestamp"];
  const level = value["level"];
  const service = value["service"];
  const message = value["message"];

  if (
    typeof id !== "string" ||
    !UUID_V4_PATTERN.test(id) ||
    typeof timestamp !== "string" ||
    !isLogLevel(level) ||
    typeof service !== "string" ||
    typeof message !== "string"
  ) {
    throw new InternalDatabaseError();
  }

  const parsedTimestamp = parseCanonicalTimestamp(timestamp);
  if (!parsedTimestamp.ok) {
    throw new InternalDatabaseError();
  }

  return {
    id: id as LogId,
    timestamp: parsedTimestamp.value.canonical,
    level,
    service,
    message,
    attributes: mapAttributes(value["attributes"]),
  };
}

function buildPageQuery(request: LogQueryPageRequest): {
  readonly text: string;
  readonly values: unknown[];
} {
  const predicate = buildLogPredicate(request.filters);
  const values = [...predicate.values];
  let cursorClause = "";

  if (request.cursor !== undefined) {
    values.push(request.cursor.timestamp, request.cursor.id);
    const timestampPlaceholder = `$${String(values.length - 1)}`;
    const idPlaceholder = `$${String(values.length)}`;
    cursorClause = `\n  AND (logs."timestamp", logs.id) < (${timestampPlaceholder}::timestamptz, ${idPlaceholder}::uuid)`;
  }

  values.push(request.limit + 1);
  const limitPlaceholder = `$${String(values.length)}`;

  return {
    text: `
SELECT
  logs.id::text AS id,
  to_char(
    logs."timestamp" AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) AS timestamp,
  logs.level,
  logs.service,
  logs.message,
  logs.attributes
FROM logstream.logs AS logs
WHERE ${predicate.text}${cursorClause}
ORDER BY logs."timestamp" DESC, logs.id DESC
LIMIT ${limitPlaceholder}::integer
`,
    values,
  };
}

export function createLogQueryRepository(pool: LogQueryDatabasePool): LogQueryRepository {
  return {
    findPage: async (request) => {
      const query = buildPageQuery(request);
      let result: LogQueryDatabaseResult;

      try {
        result = await pool.query(query.text, query.values);
      } catch (error: unknown) {
        throw translateDatabaseError(error);
      }

      try {
        if (!Array.isArray(result.rows)) {
          throw new InternalDatabaseError();
        }

        return result.rows.slice(0, request.limit + 1).map(mapRow);
      } catch (error: unknown) {
        if (error instanceof InternalDatabaseError) {
          throw error;
        }

        throw new InternalDatabaseError();
      }
    },
  };
}
