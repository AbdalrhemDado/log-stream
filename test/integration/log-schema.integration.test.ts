import { fileURLToPath } from "node:url";

import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMigrations } from "../../src/database/migrations/migration-loader.js";
import { runMigrationsWithOwnerRetry } from "../../src/database/migrations/migration-runner.js";
import type {
  MigrationDatabase,
  MigrationOwnerConnection,
} from "../../src/database/migrations/migration-types.js";
import { buildPartitionPlan } from "../../src/database/partitions/partition-plan.js";
import {
  PartitionPreparationError,
  preparePartitions,
} from "../../src/database/partitions/partition-preparer.js";

const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
const adminBaseUrl = process.env["TEST_ADMIN_DATABASE_URL"];
const ownerBaseUrl = process.env["TEST_OWNER_DATABASE_URL"];
const runtimeBaseUrl = process.env["TEST_RUNTIME_DATABASE_URL"];
const hasPostgresEnvironment =
  adminBaseUrl !== undefined && ownerBaseUrl !== undefined && runtimeBaseUrl !== undefined;
const fixedCurrentTime = new Date("2026-08-08T12:34:56.000Z");
let databaseSequence = 0;
let databaseName = "";

function databaseUrl(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function trustedDatabaseIdentifier(name: string): string {
  if (!/^logstream_schema_test_[0-9]+_[0-9]+$/u.test(name)) {
    throw new Error("Refusing an unexpected schema-test database identifier.");
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

function databaseAdapter(client: Client): MigrationDatabase {
  return {
    query: async (sql, parameters) => client.query(sql, parameters),
  };
}

async function migrateAndPrepare(retentionDays = 1): Promise<void> {
  const ownerUrl = databaseUrl(ownerBaseUrl ?? "", databaseName);
  await runMigrationsWithOwnerRetry({
    createConnection: () => ownerConnection(ownerUrl),
    loadMigrations: async () => loadMigrations(migrationsDirectory),
    timeoutMs: 10_000,
    retryDelayMs: 20,
    afterMigrations: async ({ database, deadline, retryDelayMs, clock }) => {
      await preparePartitions({
        database,
        partitions: buildPartitionPlan(fixedCurrentTime, retentionDays),
        deadline,
        retryDelayMs,
        clock,
      });
    },
  });
}

async function migrateOnly(): Promise<void> {
  const ownerUrl = databaseUrl(ownerBaseUrl ?? "", databaseName);
  await runMigrationsWithOwnerRetry({
    createConnection: () => ownerConnection(ownerUrl),
    loadMigrations: async () => loadMigrations(migrationsDirectory),
    timeoutMs: 10_000,
    retryDelayMs: 20,
  });
}

interface LogValues {
  readonly timestamp?: string;
  readonly id?: string;
  readonly level?: string;
  readonly service?: string;
  readonly message?: string;
  readonly attributes?: string | null;
  readonly attributesSearch?: string | null;
}

async function insertLog(client: Client, values: LogValues = {}): Promise<void> {
  await client.query(
    `
INSERT INTO logstream.logs
  (timestamp, id, level, service, message, attributes, attributes_search)
VALUES ($1::timestamptz, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb)
`,
    [
      values.timestamp ?? "2026-08-08T12:00:00.000Z",
      values.id ?? "00000000-0000-4000-8000-000000000001",
      values.level ?? "info",
      values.service ?? "schema-test",
      values.message ?? "test message",
      values.attributes === undefined ? "{}" : values.attributes,
      values.attributesSearch === undefined ? "{}" : values.attributesSearch,
    ],
  );
}

describe.skipIf(!hasPostgresEnvironment)("partitioned log schema with PostgreSQL", () => {
  beforeEach(async () => {
    if (adminBaseUrl === undefined) {
      throw new Error("Admin test URL is unavailable.");
    }
    databaseSequence += 1;
    databaseName = `logstream_schema_test_${String(process.pid)}_${String(databaseSequence)}`;
    await withClient(adminBaseUrl, async (admin) => {
      await admin.query(
        `CREATE DATABASE ${trustedDatabaseIdentifier(databaseName)} OWNER logstream_owner TEMPLATE template0`,
      );
    });
  });

  afterEach(async () => {
    if (adminBaseUrl === undefined || databaseName.length === 0) {
      return;
    }
    await withClient(adminBaseUrl, async (admin) => {
      await admin.query(`DROP DATABASE ${trustedDatabaseIdentifier(databaseName)} WITH (FORCE)`);
    });
  });

  it("creates the exact columns, defaults, nullability, and checks", async () => {
    await migrateAndPrepare();
    await withClient(databaseUrl(ownerBaseUrl ?? "", databaseName), async (owner) => {
      const columns = await owner.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(`
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'logstream' AND table_name = 'logs'
ORDER BY ordinal_position
`);
      expect(
        columns.rows.map(({ column_name, data_type, is_nullable }) => ({
          column_name,
          data_type,
          is_nullable,
        })),
      ).toEqual([
        { column_name: "timestamp", data_type: "timestamp with time zone", is_nullable: "NO" },
        { column_name: "id", data_type: "uuid", is_nullable: "NO" },
        { column_name: "level", data_type: "text", is_nullable: "NO" },
        { column_name: "service", data_type: "text", is_nullable: "NO" },
        { column_name: "message", data_type: "text", is_nullable: "NO" },
        { column_name: "attributes", data_type: "jsonb", is_nullable: "NO" },
        { column_name: "attributes_search", data_type: "jsonb", is_nullable: "NO" },
        {
          column_name: "created_at",
          data_type: "timestamp with time zone",
          is_nullable: "NO",
        },
      ]);
      expect(columns.rows.find((row) => row.column_name === "attributes")?.column_default).toBe(
        "'{}'::jsonb",
      );
      expect(
        columns.rows.find((row) => row.column_name === "attributes_search")?.column_default,
      ).toBe("'{}'::jsonb");
      expect(columns.rows.find((row) => row.column_name === "created_at")?.column_default).toBe(
        "CURRENT_TIMESTAMP",
      );

      const constraints = await owner.query<{ conname: string }>(`
SELECT conname
FROM pg_constraint
WHERE conrelid = 'logstream.logs'::regclass
ORDER BY conname
`);
      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "logs_attributes_object_check",
        "logs_attributes_search_object_check",
        "logs_level_check",
        "logs_message_nonempty_check",
        "logs_pkey",
        "logs_service_nonempty_check",
      ]);

      const defaults = await owner.query<{
        attributes: Record<string, unknown>;
        attributes_search: Record<string, unknown>;
        created_at: Date;
      }>(`
INSERT INTO logstream.logs (timestamp, id, level, service, message)
VALUES (
  '2026-08-08T12:00:00.000Z'::timestamptz,
  '00000000-0000-4000-8000-000000000099'::uuid,
  'info',
  'defaults-test',
  'defaults test'
)
RETURNING attributes, attributes_search, created_at
`);
      expect(defaults.rows[0]?.attributes).toEqual({});
      expect(defaults.rows[0]?.attributes_search).toEqual({});
      expect(defaults.rows[0]?.created_at).toBeInstanceOf(Date);
    });
  });

  it("enforces literal string, level, and JSON-object constraints", async () => {
    await migrateAndPrepare();
    await withClient(databaseUrl(ownerBaseUrl ?? "", databaseName), async (owner) => {
      for (const [index, level] of ["debug", "info", "warn", "error"].entries()) {
        await insertLog(owner, {
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          level,
        });
      }
      await expect(
        insertLog(owner, { id: "00000000-0000-4000-8000-000000000010", level: "fatal" }),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        insertLog(owner, { id: "00000000-0000-4000-8000-000000000011", service: "" }),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        insertLog(owner, { id: "00000000-0000-4000-8000-000000000012", message: "" }),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        insertLog(owner, {
          id: "00000000-0000-4000-8000-000000000013",
          service: "   ",
          message: "\t",
        }),
      ).resolves.toBeUndefined();
      await expect(
        insertLog(owner, {
          id: "00000000-0000-4000-8000-000000000014",
          attributes: '{"attempt":1}',
          attributesSearch: '{"attempt":"1"}',
        }),
      ).resolves.toBeUndefined();

      for (const [index, invalidJson] of ["[]", '"scalar"', "true", "null"].entries()) {
        await expect(
          insertLog(owner, {
            id: `00000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`,
            attributes: invalidJson,
          }),
        ).rejects.toMatchObject({ code: "23514" });
        await expect(
          insertLog(owner, {
            id: `00000000-0000-4000-8000-${String(index + 30).padStart(12, "0")}`,
            attributesSearch: invalidJson,
          }),
        ).rejects.toMatchObject({ code: "23514" });
      }
      await expect(
        insertLog(owner, {
          id: "00000000-0000-4000-8000-000000000040",
          attributes: null,
        }),
      ).rejects.toMatchObject({ code: "23502" });
    });
  });

  it("creates only the approved parent index families", async () => {
    await migrateAndPrepare();
    await withClient(databaseUrl(ownerBaseUrl ?? "", databaseName), async (owner) => {
      const primaryKey = await owner.query<{ definition: string }>(`
SELECT pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'logstream.logs'::regclass AND contype = 'p'
`);
      expect(primaryKey.rows[0]?.definition.replaceAll('"', "")).toBe(
        "PRIMARY KEY (timestamp, id)",
      );

      const indexes = await owner.query<{ indexname: string; indexdef: string }>(`
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'logstream' AND tablename = 'logs'
ORDER BY indexname
`);
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "logs_pkey",
        "logs_service_timestamp_id_idx",
      ]);
      expect(indexes.rows[1]?.indexdef.replaceAll('"', "")).toContain(
        "(service, timestamp DESC, id DESC)",
      );

      const allIndexes = await owner.query<{ access_method: string; definition: string }>(`
SELECT access_method.amname AS access_method, pg_get_indexdef(index_class.oid) AS definition
FROM pg_index AS index_metadata
JOIN pg_class AS index_class ON index_class.oid = index_metadata.indexrelid
JOIN pg_class AS table_class ON table_class.oid = index_metadata.indrelid
JOIN pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
JOIN pg_am AS access_method ON access_method.oid = index_class.relam
WHERE namespace.nspname = 'logstream'
  AND (table_class.relname = 'logs' OR table_class.relname LIKE 'logs\\_%' ESCAPE '\\')
`);
      expect(allIndexes.rows.every((index) => index.access_method === "btree")).toBe(true);
      expect(
        allIndexes.rows.some((index) =>
          /level|gin|trgm|message|created_at/iu.test(index.definition),
        ),
      ).toBe(false);
    });
  });

  it("creates the default and exact prepared UTC daily partitions idempotently", async () => {
    await migrateAndPrepare(30);
    const expectedPlan = buildPartitionPlan(fixedCurrentTime, 30);
    const ownerUrl = databaseUrl(ownerBaseUrl ?? "", databaseName);
    await withClient(ownerUrl, async (owner) => {
      const database = databaseAdapter(owner);
      await preparePartitions({ database, partitions: expectedPlan });
      const partitioning = await owner.query<{ key: string; strategy: string }>(`
SELECT pg_get_partkeydef(class.oid) AS key, partitioned.partstrat AS strategy
FROM pg_class AS class
JOIN pg_partitioned_table AS partitioned ON partitioned.partrelid = class.oid
WHERE class.oid = 'logstream.logs'::regclass
`);
      expect(partitioning.rows[0]?.key.replaceAll('"', "")).toBe("RANGE (timestamp)");
      expect(partitioning.rows[0]?.strategy).toBe("r");

      const partitions = await owner.query<{ name: string; bound: string; owner: string }>(`
SELECT
  child.relname AS name,
  pg_get_expr(child.relpartbound, child.oid) AS bound,
  owner_role.rolname AS owner
FROM pg_inherits AS inheritance
JOIN pg_class AS child ON child.oid = inheritance.inhrelid
JOIN pg_roles AS owner_role ON owner_role.oid = child.relowner
WHERE inheritance.inhparent = 'logstream.logs'::regclass
ORDER BY child.relname
`);
      expect(partitions.rows.map((row) => row.name)).toEqual(
        [...expectedPlan.map((partition) => partition.name), "logs_default"].toSorted(),
      );
      expect(partitions.rows.every((row) => row.owner === "logstream_owner")).toBe(true);
      expect(partitions.rows.find((row) => row.name === "logs_default")?.bound).toBe("DEFAULT");
      expect(partitions.rows.find((row) => row.name === "logs_20260808")?.bound).toContain(
        "2026-08-08 00:00:00+00",
      );
      const parentOwner = await owner.query<{ owner: string }>(`
SELECT owner_role.rolname AS owner
FROM pg_class AS parent
JOIN pg_roles AS owner_role ON owner_role.oid = parent.relowner
WHERE parent.oid = 'logstream.logs'::regclass
`);
      expect(parentOwner.rows).toEqual([{ owner: "logstream_owner" }]);
      const childPrivileges = await owner.query<{
        public_privileges: number;
        runtime_direct_select: boolean;
        runtime_direct_insert: boolean;
      }>(`
SELECT
  (
    SELECT COUNT(*)::integer
    FROM aclexplode(COALESCE(child.relacl, acldefault('r', child.relowner))) AS privilege
    WHERE privilege.grantee = 0
  ) AS public_privileges,
  has_table_privilege('logstream_runtime', child.oid, 'SELECT') AS runtime_direct_select,
  has_table_privilege('logstream_runtime', child.oid, 'INSERT') AS runtime_direct_insert
FROM pg_inherits AS inheritance
JOIN pg_class AS child ON child.oid = inheritance.inhrelid
WHERE inheritance.inhparent = 'logstream.logs'::regclass
ORDER BY child.relname
`);
      expect(childPrivileges.rows.every((row) => row.public_privileges === 0)).toBe(true);
      expect(childPrivileges.rows.every((row) => !row.runtime_direct_select)).toBe(true);
      expect(childPrivileges.rows.every((row) => !row.runtime_direct_insert)).toBe(true);
    });
  });

  it("routes boundary, old, and beyond-future timestamps to the correct partitions", async () => {
    await migrateAndPrepare();
    await withClient(databaseUrl(ownerBaseUrl ?? "", databaseName), async (owner) => {
      const timestamps = [
        "2026-08-08T00:00:00.000Z",
        "2026-08-08T23:59:59.999Z",
        "2026-08-09T00:00:00.000Z",
        "2000-01-01T00:00:00.000Z",
        "2026-08-20T00:00:00.000Z",
      ];
      for (const [index, timestamp] of timestamps.entries()) {
        await insertLog(owner, {
          timestamp,
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        });
      }
      const routing = await owner.query<{ partition_name: string; timestamp: Date }>(`
SELECT tableoid::regclass::text AS partition_name, timestamp
FROM logstream.logs
ORDER BY timestamp, id
`);
      expect(routing.rows.map((row) => row.partition_name)).toEqual([
        "logstream.logs_default",
        "logstream.logs_20260808",
        "logstream.logs_20260808",
        "logstream.logs_20260809",
        "logstream.logs_default",
      ]);
    });
  });

  it("allows runtime parent reads/inserts but denies storage DDL and migration history", async () => {
    await migrateAndPrepare();
    await withClient(databaseUrl(runtimeBaseUrl ?? "", databaseName), async (runtime) => {
      await insertLog(runtime);
      const rows = await runtime.query<{ count: number }>(
        "SELECT COUNT(*)::integer AS count FROM logstream.logs",
      );
      expect(rows.rows).toEqual([{ count: 1 }]);
      const membership = await runtime.query<{ owner_member: boolean }>(
        "SELECT pg_has_role(current_user, 'logstream_owner', 'MEMBER') AS owner_member",
      );
      expect(membership.rows).toEqual([{ owner_member: false }]);
      await expect(
        runtime.query("CREATE TABLE logstream.forbidden (id integer)"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtime.query("ALTER TABLE logstream.logs ADD COLUMN forbidden integer"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(runtime.query("DROP TABLE logstream.logs")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        runtime.query("SELECT version FROM logstream_migrations.schema_migrations"),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("serializes concurrent partition preparation without duplicate children", async () => {
    await migrateOnly();
    const plan = buildPartitionPlan(fixedCurrentTime, 1);
    const ownerUrl = databaseUrl(ownerBaseUrl ?? "", databaseName);
    const first = new Client({ connectionString: ownerUrl });
    const second = new Client({ connectionString: ownerUrl });
    await Promise.all([first.connect(), second.connect()]);
    try {
      await Promise.all([
        preparePartitions({ database: databaseAdapter(first), partitions: plan }),
        preparePartitions({ database: databaseAdapter(second), partitions: plan }),
      ]);
      const inventory = await first.query<{ count: number }>(`
SELECT COUNT(*)::integer AS count
FROM pg_inherits
WHERE inhparent = 'logstream.logs'::regclass
`);
      expect(inventory.rows).toEqual([{ count: plan.length + 1 }]);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });

  it("moves overlapping default rows atomically before attaching a missing partition", async () => {
    await migrateOnly();
    const ownerUrl = databaseUrl(ownerBaseUrl ?? "", databaseName);
    await withClient(ownerUrl, async (owner) => {
      await insertLog(owner, {
        level: "warn",
        service: "overlap-service",
        message: "preserve this row",
        attributes: '{"attempt":7,"active":true}',
        attributesSearch: '{"attempt":"7","active":"true"}',
      });
      const before = await owner.query<{
        timestamp: Date;
        id: string;
        level: string;
        service: string;
        message: string;
        attributes: Record<string, unknown>;
        attributes_search: Record<string, unknown>;
        created_at: Date;
      }>(`
SELECT timestamp, id, level, service, message, attributes, attributes_search, created_at
FROM logstream.logs
`);
      const [target] = buildPartitionPlan(fixedCurrentTime, 1).filter(
        (partition) => partition.name === "logs_20260808",
      );
      if (target === undefined) {
        throw new Error("Target partition is unavailable.");
      }
      await preparePartitions({ database: databaseAdapter(owner), partitions: [target] });
      const evidence = await owner.query<{ partition_name: string; count: number }>(`
SELECT tableoid::regclass::text AS partition_name, COUNT(*)::integer AS count
FROM logstream.logs
GROUP BY tableoid
`);
      expect(evidence.rows).toEqual([{ partition_name: "logstream.logs_20260808", count: 1 }]);
      const defaultCount = await owner.query<{ count: number }>(
        "SELECT COUNT(*)::integer AS count FROM logstream.logs_default",
      );
      expect(defaultCount.rows).toEqual([{ count: 0 }]);
      const after = await owner.query<{
        timestamp: Date;
        id: string;
        level: string;
        service: string;
        message: string;
        attributes: Record<string, unknown>;
        attributes_search: Record<string, unknown>;
        created_at: Date;
      }>(`
SELECT timestamp, id, level, service, message, attributes, attributes_search, created_at
FROM logstream.logs
`);
      expect(after.rows).toEqual(before.rows);
    });
  });

  it("rolls back failed overlap recovery without losing the default row", async () => {
    await migrateOnly();
    const ownerUrl = databaseUrl(ownerBaseUrl ?? "", databaseName);
    await withClient(ownerUrl, async (owner) => {
      await insertLog(owner);
      await owner.query(`
CREATE FUNCTION logstream.reject_default_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'forced recovery failure';
END
$$;
CREATE TRIGGER reject_default_delete
BEFORE DELETE ON logstream.logs_default
FOR EACH ROW EXECUTE FUNCTION logstream.reject_default_delete();
`);
      const [target] = buildPartitionPlan(fixedCurrentTime, 1).filter(
        (partition) => partition.name === "logs_20260808",
      );
      if (target === undefined) {
        throw new Error("Target partition is unavailable.");
      }

      await expect(
        preparePartitions({ database: databaseAdapter(owner), partitions: [target] }),
      ).rejects.toBeInstanceOf(PartitionPreparationError);
      const evidence = await owner.query<{ partition_name: string; child_exists: string | null }>(`
SELECT
  tableoid::regclass::text AS partition_name,
  to_regclass('logstream.logs_20260808')::text AS child_exists
FROM logstream.logs
`);
      expect(evidence.rows).toEqual([
        { partition_name: "logstream.logs_default", child_exists: null },
      ]);
    });
  });
});
