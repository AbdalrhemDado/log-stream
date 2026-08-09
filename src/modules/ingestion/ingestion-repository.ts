import { translateDatabaseError } from "../../database/database-errors.js";
import type { LogInsertionRecord } from "../../domain/log-entry.js";

export interface IngestionDatabaseClient {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
  release(destroy?: boolean): void;
}

export interface IngestionDatabasePool {
  connect(): Promise<IngestionDatabaseClient>;
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
`;

function serializeJsonb(value: object): string {
  return JSON.stringify(value);
}

function buildInsertParameters(records: readonly LogInsertionRecord[]): unknown[] {
  return [
    records.map((record) => record.timestamp),
    records.map((record) => record.id),
    records.map((record) => record.level),
    records.map((record) => record.service),
    records.map((record) => record.message),
    records.map((record) => serializeJsonb(record.attributes)),
    records.map((record) => serializeJsonb(record.attributesSearch)),
  ];
}

async function rollbackAfterFailure(client: IngestionDatabaseClient): Promise<boolean> {
  try {
    await client.query("ROLLBACK");
    return true;
  } catch {
    return false;
  }
}

function releaseClient(client: IngestionDatabaseClient, destroy: boolean): void {
  if (destroy) {
    client.release(true);
    return;
  }

  client.release();
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

      let client: IngestionDatabaseClient;
      try {
        client = await pool.connect();
      } catch (error: unknown) {
        throw translateDatabaseError(error);
      }

      let operationError: Error | undefined;
      let transactionBegan = false;
      let destroyClient = false;

      try {
        await client.query("BEGIN");
        transactionBegan = true;
        await client.query(INSERT_LOGS_SQL, parameters);
        await client.query("COMMIT");
      } catch (error: unknown) {
        if (transactionBegan) {
          // After COMMIT starts, rollback is best-effort cleanup, not proof that commit failed.
          destroyClient = !(await rollbackAfterFailure(client));
        } else {
          // BEGIN failed, so the server-side session state cannot be trusted for reuse.
          destroyClient = true;
        }
        operationError = translateDatabaseError(error);
      }

      try {
        releaseClient(client, destroyClient);
      } catch (error: unknown) {
        operationError ??= translateDatabaseError(error);
      }

      if (operationError !== undefined) {
        throw operationError;
      }
    },
  };
}
