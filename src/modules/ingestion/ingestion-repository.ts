import { translateDatabaseError } from "../../database/database-errors.js";
import type { LogInsertionRecord } from "../../domain/log-entry.js";

export interface IngestionDatabasePool {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

export interface IngestionRepository {
  insert(records: readonly LogInsertionRecord[]): Promise<void>;
}

const INSERT_LOGS_SQL = `
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
  COALESCE(
    (
      SELECT jsonb_object_agg(attribute.key, to_jsonb(attribute.value #>> '{}'))
      FROM jsonb_each(batch.attributes) AS attribute(key, value)
    ),
    '{}'::jsonb
  )
FROM UNNEST(
  $1::timestamptz[],
  $2::uuid[],
  $3::text[],
  $4::text[],
  $5::text[],
  $6::jsonb[]
) AS batch(timestamp, id, level, service, message, attributes)
`;

function serializeJsonb(value: object): string {
  return JSON.stringify(value);
}

function buildInsertParameters(records: readonly LogInsertionRecord[]): unknown[] {
  const timestamps = new Array<LogInsertionRecord["timestamp"]>(records.length);
  const ids = new Array<LogInsertionRecord["id"]>(records.length);
  const levels = new Array<LogInsertionRecord["level"]>(records.length);
  const services = new Array<string>(records.length);
  const messages = new Array<string>(records.length);
  const attributes = new Array<string>(records.length);

  for (const [index, record] of records.entries()) {
    timestamps[index] = record.timestamp;
    ids[index] = record.id;
    levels[index] = record.level;
    services[index] = record.service;
    messages[index] = record.message;
    attributes[index] = serializeJsonb(record.attributes);
  }

  return [timestamps, ids, levels, services, messages, attributes];
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
        // A single INSERT is already an atomic PostgreSQL transaction. The query promise
        // resolves only after PostgreSQL has committed it, so explicit BEGIN/COMMIT
        // commands would add two round trips without improving durability.
        await pool.query(INSERT_LOGS_SQL, parameters);
      } catch (error: unknown) {
        throw translateDatabaseError(error);
      }
    },
  };
}
