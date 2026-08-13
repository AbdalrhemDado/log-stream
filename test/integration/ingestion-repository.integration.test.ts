import { fileURLToPath } from "node:url";

import { Client, Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InternalDatabaseError } from "../../src/database/database-errors.js";
import { loadMigrations } from "../../src/database/migrations/migration-loader.js";
import { runMigrationsWithOwnerRetry } from "../../src/database/migrations/migration-runner.js";
import type { MigrationOwnerConnection } from "../../src/database/migrations/migration-types.js";
import { buildPartitionPlan } from "../../src/database/partitions/partition-plan.js";
import { preparePartitions } from "../../src/database/partitions/partition-preparer.js";
import { normalizeAttributes } from "../../src/domain/attribute-normalizer.js";
import { validateLogEntry } from "../../src/domain/log-entry-validator.js";
import type { LogId, LogInsertionRecord } from "../../src/domain/log-entry.js";
import { createIngestionRepository } from "../../src/modules/ingestion/ingestion-repository.js";
import { endPoolAndWaitForClients } from "../harness/postgres-pool-teardown.js";

const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
const adminBaseUrl = process.env["TEST_ADMIN_DATABASE_URL"];
const ownerBaseUrl = process.env["TEST_OWNER_DATABASE_URL"];
const runtimeBaseUrl = process.env["TEST_RUNTIME_DATABASE_URL"];
const hasPostgresEnvironment =
  adminBaseUrl !== undefined && ownerBaseUrl !== undefined && runtimeBaseUrl !== undefined;
const fixedCurrentTime = new Date("2026-08-08T12:34:56.000Z");
let databaseSequence = 0;
let databaseName = "";
let runtimePool: Pool | undefined;

function databaseUrl(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function trustedDatabaseIdentifier(name: string): string {
  if (!/^logstream_ingestion_repository_test_[0-9]+_[0-9]+$/u.test(name)) {
    throw new Error("Refusing an unexpected ingestion-repository test database identifier.");
  }
  return `"${name}"`;
}

async function withClient<T>(connectionString: string, operation: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

function ownerConnection(connectionString: string): MigrationOwnerConnection {
  const client = new Client({ connectionString });
  return {
    connect: async () => {
      await client.connect();
    },
    end: async () => {
      await client.end();
    },
    query: async (sql, parameters) => client.query(sql, parameters),
  };
}

async function migrateAndPrepare(): Promise<void> {
  const ownerUrl = databaseUrl(ownerBaseUrl ?? "", databaseName);
  await runMigrationsWithOwnerRetry({
    createConnection: () => ownerConnection(ownerUrl),
    loadMigrations: async () => loadMigrations(migrationsDirectory),
    timeoutMs: 10_000,
    retryDelayMs: 20,
    afterMigrations: async ({ database, deadline, retryDelayMs, clock }) => {
      await preparePartitions({
        database,
        partitions: buildPartitionPlan(fixedCurrentTime, 1),
        deadline,
        retryDelayMs,
        clock,
      });
    },
  });
}

function insertionRecord(
  id: string,
  input: {
    readonly timestamp: string;
    readonly level: string;
    readonly service: string;
    readonly message: string;
    readonly attributes?: object;
  },
): LogInsertionRecord {
  const result = validateLogEntry(input, fixedCurrentTime.getTime());

  if (!result.ok) {
    throw new Error(`Integration record failed validation: ${result.reason}`);
  }

  return {
    ...result.value,
    id: id as LogId,
    attributesSearch: normalizeAttributes(result.value.attributes),
  };
}

describe.skipIf(!hasPostgresEnvironment)("ingestion repository with PostgreSQL", () => {
  beforeEach(async () => {
    if (adminBaseUrl === undefined || runtimeBaseUrl === undefined) {
      throw new Error("PostgreSQL integration URLs are unavailable.");
    }

    databaseSequence += 1;
    databaseName = `logstream_ingestion_repository_test_${String(process.pid)}_${String(databaseSequence)}`;
    await withClient(adminBaseUrl, async (admin) => {
      await admin.query(
        `CREATE DATABASE ${trustedDatabaseIdentifier(databaseName)} OWNER logstream_owner TEMPLATE template0`,
      );
    });
    await migrateAndPrepare();
    runtimePool = new Pool({
      connectionString: databaseUrl(runtimeBaseUrl, databaseName),
      max: 4,
    });
  });

  afterEach(async () => {
    if (runtimePool !== undefined) {
      await endPoolAndWaitForClients(runtimePool);
      runtimePool = undefined;
    }

    if (adminBaseUrl === undefined || databaseName.length === 0) {
      return;
    }

    await withClient(adminBaseUrl, async (admin) => {
      await admin.query(`DROP DATABASE ${trustedDatabaseIdentifier(databaseName)} WITH (FORCE)`);
    });
  });

  it("stores a special-key multi-record batch through the runtime role and correct partitions", async () => {
    if (runtimePool === undefined) {
      throw new Error("Runtime pool was not created.");
    }

    const injectionText = "checkout'); DROP TABLE logstream.logs; --";
    const specialAttributes = JSON.parse(
      `{"":"empty-key","שלום":"unicode-value","__proto__":"prototype-value","constructor":"constructor-value","retries":3,"enabled":true,"disabled":false,"attack":${JSON.stringify(injectionText)}}`,
    ) as object;
    const currentRecord = insertionRecord("00000000-0000-4000-8000-000000000101", {
      timestamp: "2026-08-08T11:45:00.123Z",
      level: "error",
      service: injectionText,
      message: "message'); SELECT pg_sleep(10); --",
      attributes: specialAttributes,
    });
    const oldRecord = insertionRecord("00000000-0000-4000-8000-000000000102", {
      timestamp: "2000-01-01T00:00:00.000Z",
      level: "info",
      service: "archive",
      message: "old but valid",
      attributes: { text: "42", count: 42, active: true },
    });
    const repository = createIngestionRepository(runtimePool);

    await expect(repository.insert([currentRecord, oldRecord])).resolves.toBeUndefined();

    const identity = await runtimePool.query<{ role_name: string; is_superuser: boolean }>(`
SELECT current_user AS role_name, roles.rolsuper AS is_superuser
FROM pg_roles AS roles
WHERE roles.rolname = current_user
`);
    expect(identity.rows).toEqual([{ role_name: "logstream_runtime", is_superuser: false }]);

    const stored = await runtimePool.query<{
      timestamp: Date;
      id: string;
      level: string;
      service: string;
      message: string;
      attributes: Record<string, unknown>;
      attributes_search: Record<string, string>;
      created_at: Date;
      partition_name: string;
    }>(`
SELECT
  timestamp,
  id,
  level,
  service,
  message,
  attributes,
  attributes_search,
  created_at,
  tableoid::regclass::text AS partition_name
FROM logstream.logs
ORDER BY id
`);

    expect(stored.rows).toHaveLength(2);
    const [current, old] = stored.rows;
    expect(current).toMatchObject({
      id: currentRecord.id,
      level: currentRecord.level,
      service: currentRecord.service,
      message: currentRecord.message,
      attributes: currentRecord.attributes,
      attributes_search: currentRecord.attributesSearch,
      partition_name: "logstream.logs_20260808",
    });
    expect(current?.timestamp.toISOString()).toBe(currentRecord.timestamp);
    expect(current?.created_at).toBeInstanceOf(Date);
    expect(Object.hasOwn(current?.attributes ?? {}, "")).toBe(true);
    expect(Object.hasOwn(current?.attributes ?? {}, "שלום")).toBe(true);
    expect(Object.hasOwn(current?.attributes ?? {}, "__proto__")).toBe(true);
    expect(Object.hasOwn(current?.attributes ?? {}, "constructor")).toBe(true);
    expect(current?.attributes["retries"]).toBe(3);
    expect(typeof current?.attributes["retries"]).toBe("number");
    expect(current?.attributes["enabled"]).toBe(true);
    expect(typeof current?.attributes["enabled"]).toBe("boolean");
    expect(current?.attributes_search["retries"]).toBe("3");
    expect(current?.attributes_search["enabled"]).toBe("true");
    expect(current?.attributes_search["disabled"]).toBe("false");
    expect(current?.attributes["attack"]).toBe(injectionText);

    expect(old).toMatchObject({
      id: oldRecord.id,
      level: oldRecord.level,
      service: oldRecord.service,
      message: oldRecord.message,
      attributes: oldRecord.attributes,
      attributes_search: oldRecord.attributesSearch,
      partition_name: "logstream.logs_default",
    });
    expect(old?.timestamp.toISOString()).toBe(oldRecord.timestamp);
    expect(old?.attributes["text"]).toBe("42");
    expect(typeof old?.attributes["text"]).toBe("string");
    expect(old?.attributes["count"]).toBe(42);
    expect(old?.attributes_search["count"]).toBe("42");
    expect(old?.attributes_search["active"]).toBe("true");

    const tableEvidence = await runtimePool.query<{ table_name: string | null; count: number }>(`
SELECT
  to_regclass('logstream.logs')::text AS table_name,
  (SELECT COUNT(*)::integer FROM logstream.logs) AS count
`);
    expect(tableEvidence.rows).toEqual([{ table_name: "logstream.logs", count: 2 }]);
  });

  it("translates a duplicate-key failure and rolls back every row in that request", async () => {
    if (runtimePool === undefined) {
      throw new Error("Runtime pool was not created.");
    }

    const repository = createIngestionRepository(runtimePool);
    const sentinel = insertionRecord("00000000-0000-4000-8000-000000000200", {
      timestamp: "2026-08-08T10:00:00.000Z",
      level: "info",
      service: "sentinel",
      message: "keep this row",
    });
    await repository.insert([sentinel]);

    const duplicateId = "00000000-0000-4000-8000-000000000201";
    const first = insertionRecord(duplicateId, {
      timestamp: "2026-08-08T10:30:00.000Z",
      level: "warn",
      service: "first-in-failed-batch",
      message: "first",
    });
    const duplicate = insertionRecord(duplicateId, {
      timestamp: first.timestamp,
      level: "error",
      service: "duplicate-in-failed-batch",
      message: "duplicate",
    });

    await expect(repository.insert([first, duplicate])).rejects.toBeInstanceOf(
      InternalDatabaseError,
    );

    const evidence = await runtimePool.query<{ id: string; service: string }>(`
SELECT id, service
FROM logstream.logs
ORDER BY id
`);
    expect(evidence.rows).toEqual([{ id: sentinel.id, service: sentinel.service }]);
  });
});
