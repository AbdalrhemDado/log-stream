import { fileURLToPath } from "node:url";

import { Client, Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMigrations } from "../../src/database/migrations/migration-loader.js";
import { runMigrationsWithOwner } from "../../src/database/migrations/migration-runner.js";
import type { MigrationOwnerConnection } from "../../src/database/migrations/migration-types.js";
import { buildPartitionPlan } from "../../src/database/partitions/partition-plan.js";
import type { CanonicalUtcTimestamp } from "../../src/domain/log-entry.js";
import {
  createRetentionRepository,
  type RetentionDatabasePool,
} from "../../src/modules/retention/retention-repository.js";

const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
const adminBaseUrl = process.env["TEST_ADMIN_DATABASE_URL"];
const ownerBaseUrl = process.env["TEST_OWNER_DATABASE_URL"];
const runtimeBaseUrl = process.env["TEST_RUNTIME_DATABASE_URL"];
const hasPostgresEnvironment =
  adminBaseUrl !== undefined && ownerBaseUrl !== undefined && runtimeBaseUrl !== undefined;
let databaseSequence = 0;
let databaseName = "";

function databaseUrl(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function trustedDatabaseIdentifier(name: string): string {
  if (!/^logstream_retention_test_[0-9]+_[0-9]+$/u.test(name)) {
    throw new Error("Refusing an unexpected retention-test database identifier.");
  }
  return `"${name}"`;
}

function trustedPartitionIdentifier(name: string): string {
  if (!/^logs_[0-9]{8}$/u.test(name)) {
    throw new Error("Refusing an unexpected retention-test partition identifier.");
  }
  return `"${name}"`;
}

function trustedNestedPartitionIdentifier(name: string): string {
  if (!/^logs_[0-9]{8}_nested$/u.test(name)) {
    throw new Error("Refusing an unexpected nested retention-test partition identifier.");
  }
  return `"${name}"`;
}

function trustedTimestampLiteral(value: string): string {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00\.000Z$/u.test(value)) {
    throw new Error("Refusing an unexpected retention-test timestamp literal.");
  }
  return `'${value}'::timestamptz`;
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

async function applyMigrations(): Promise<void> {
  await runMigrationsWithOwner({
    connection: ownerConnection(databaseUrl(ownerBaseUrl ?? "", databaseName)),
    loadMigrations: async () => loadMigrations(migrationsDirectory),
  });
}

async function databaseReference(client: Client): Promise<{
  readonly now: CanonicalUtcTimestamp;
  readonly utcDay: CanonicalUtcTimestamp;
}> {
  const result = await client.query<{ now: string; utc_day: string }>(`
SELECT
  to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now,
  to_char(
    date_trunc('day', statement_timestamp() AT TIME ZONE 'UTC'),
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) AS utc_day
`);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Database reference time is unavailable.");
  }
  return {
    now: row.now as CanonicalUtcTimestamp,
    utcDay: row.utc_day as CanonicalUtcTimestamp,
  };
}

function shift(timestamp: string, milliseconds: number): CanonicalUtcTimestamp {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString() as CanonicalUtcTimestamp;
}

async function insertLog(
  client: Client,
  timestamp: string,
  id: string,
  createdAt = timestamp,
): Promise<void> {
  await client.query(
    `
INSERT INTO logstream.logs
  (timestamp, id, level, service, message, attributes, attributes_search, created_at)
VALUES ($1::timestamptz, $2::uuid, 'info', 'retention-test', 'retention test', '{}', '{}', $3)
`,
    [timestamp, id, createdAt],
  );
}

function runtimePoolAdapter(pool: Pool): RetentionDatabasePool {
  return {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql, parameters) => client.query(sql, parameters),
        release: (destroy) => {
          client.release(destroy);
        },
      };
    },
  };
}

describe.skipIf(!hasPostgresEnvironment)(
  "retention routines and repository with PostgreSQL",
  () => {
    beforeEach(async () => {
      databaseSequence += 1;
      databaseName = `logstream_retention_test_${String(process.pid)}_${String(databaseSequence)}`;
      await withClient(adminBaseUrl ?? "", async (admin) => {
        await admin.query(
          `CREATE DATABASE ${trustedDatabaseIdentifier(databaseName)} OWNER logstream_owner TEMPLATE template0`,
        );
      });
      await applyMigrations();
    });

    afterEach(async () => {
      if (databaseName.length === 0) {
        return;
      }
      await withClient(adminBaseUrl ?? "", async (admin) => {
        await admin.query(`DROP DATABASE ${trustedDatabaseIdentifier(databaseName)} WITH (FORCE)`);
      });
    });

    it("validates scalar arguments before advisory-lock contention", async () => {
      const runtimeUrl = databaseUrl(runtimeBaseUrl ?? "", databaseName);
      const blocker = new Client({ connectionString: runtimeUrl });
      const caller = new Client({ connectionString: runtimeUrl });
      await Promise.all([blocker.connect(), caller.connect()]);
      try {
        const reference = await databaseReference(caller);
        await blocker.query("SELECT pg_advisory_lock($1, $2)", [1_815_642_963, 2]);

        await expect(
          caller.query("SELECT logstream.ensure_log_partition($1)", [
            shift(reference.utcDay, 60_000),
          ]),
        ).rejects.toMatchObject({ message: "Retention partition start is invalid." });
        await expect(
          caller.query("SELECT logstream.drop_one_expired_log_partition($1)", ["infinity"]),
        ).rejects.toMatchObject({ message: "Retention cutoff is invalid." });
        await expect(
          caller.query("SELECT logstream.delete_expired_default_logs($1, $2)", [reference.now, 0]),
        ).rejects.toMatchObject({ message: "Retention batch size is invalid." });
        await expect(
          caller.query("SELECT logstream.ensure_log_partition($1)", [reference.utcDay]),
        ).rejects.toMatchObject({ message: "Retention maintenance lock is unavailable." });
      } finally {
        await blocker.query("SELECT pg_advisory_unlock($1, $2)", [1_815_642_963, 2]);
        await Promise.all([blocker.end(), caller.end()]);
      }
    });

    it("enforces the exact database-time windows for partition starts and cutoffs", async () => {
      await withClient(databaseUrl(runtimeBaseUrl ?? "", databaseName), async (runtime) => {
        const reference = await databaseReference(runtime);
        for (const invalidStart of [null, "infinity", "-infinity"]) {
          await expect(
            runtime.query("SELECT logstream.ensure_log_partition($1)", [invalidStart]),
          ).rejects.toMatchObject({ message: "Retention partition start is invalid." });
        }
        const allowedStarts = [-1, 0, 1, 2].map((days) =>
          shift(reference.utcDay, days * 86_400_000),
        );
        for (const start of allowedStarts) {
          await expect(
            runtime.query("SELECT logstream.ensure_log_partition($1) AS created", [start]),
          ).resolves.toBeDefined();
        }
        await expect(
          runtime.query("SELECT logstream.ensure_log_partition($1)", [
            shift(reference.utcDay, -2 * 86_400_000),
          ]),
        ).rejects.toMatchObject({ message: "Retention partition start is invalid." });
        await expect(
          runtime.query("SELECT logstream.ensure_log_partition($1)", [
            shift(reference.utcDay, 3 * 86_400_000),
          ]),
        ).rejects.toMatchObject({ message: "Retention partition start is invalid." });

        const lowerInside = shift(reference.now, -3_650 * 86_400_000);
        await expect(
          runtime.query("SELECT logstream.drop_one_expired_log_partition($1)", [lowerInside]),
        ).resolves.toBeDefined();
        await expect(
          runtime.query(
            "SELECT logstream.drop_one_expired_log_partition(statement_timestamp() - INTERVAL '3651 days')",
          ),
        ).resolves.toBeDefined();
        await expect(
          runtime.query("SELECT logstream.delete_expired_default_logs(statement_timestamp(), 1)"),
        ).resolves.toBeDefined();
        await expect(
          runtime.query("SELECT logstream.drop_one_expired_log_partition($1)", [
            shift(reference.now, -3_652 * 86_400_000),
          ]),
        ).rejects.toMatchObject({ message: "Retention cutoff is invalid." });
        await expect(
          runtime.query("SELECT logstream.delete_expired_default_logs($1, 1)", [
            shift(reference.now, 60_000),
          ]),
        ).rejects.toMatchObject({ message: "Retention cutoff is invalid." });
        await expect(
          runtime.query("SELECT logstream.delete_expired_default_logs(NULL, 1)"),
        ).rejects.toMatchObject({ message: "Retention cutoff is invalid." });
        await expect(
          runtime.query("SELECT logstream.drop_one_expired_log_partition(NULL)"),
        ).rejects.toMatchObject({ message: "Retention cutoff is invalid." });
        await expect(
          runtime.query("SELECT logstream.delete_expired_default_logs('-infinity', 1)"),
        ).rejects.toMatchObject({ message: "Retention cutoff is invalid." });
        for (const invalidBatch of [null, -1, 0, 10_001]) {
          await expect(
            runtime.query("SELECT logstream.delete_expired_default_logs($1, $2)", [
              reference.now,
              invalidBatch,
            ]),
          ).rejects.toMatchObject({ message: "Retention batch size is invalid." });
        }
        await expect(
          runtime.query("SELECT logstream.delete_expired_default_logs($1, 10000)", [reference.now]),
        ).resolves.toMatchObject({ rows: [{ delete_expired_default_logs: 0 }] });
      });
    });

    it("creates only the exact child with owner, privileges, bounds, and inherited index families", async () => {
      await withClient(databaseUrl(runtimeBaseUrl ?? "", databaseName), async (runtime) => {
        const reference = await databaseReference(runtime);
        await expect(
          runtime.query<{ created: boolean }>(
            "SELECT logstream.ensure_log_partition($1) AS created",
            [reference.utcDay],
          ),
        ).resolves.toMatchObject({ rows: [{ created: true }] });
        await expect(
          runtime.query<{ created: boolean }>(
            "SELECT logstream.ensure_log_partition($1) AS created",
            [reference.utcDay],
          ),
        ).resolves.toMatchObject({ rows: [{ created: false }] });

        const expectedName = buildPartitionPlan(new Date(reference.now), 1)[1]?.name;
        const inventory = await runtime.query<{
          name: string;
          owner: string;
          bound: string;
          runtime_select: boolean;
          runtime_insert: boolean;
          public_privileges: number;
        }>(`
SELECT
  child.relname AS name,
  owner.rolname AS owner,
  pg_get_expr(child.relpartbound, child.oid) AS bound,
  has_table_privilege('logstream_runtime', child.oid, 'SELECT') AS runtime_select,
  has_table_privilege('logstream_runtime', child.oid, 'INSERT') AS runtime_insert,
  (
    SELECT COUNT(*)::integer
    FROM aclexplode(COALESCE(child.relacl, acldefault('r', child.relowner))) AS privilege
    WHERE privilege.grantee = 0
  ) AS public_privileges
FROM pg_inherits AS inheritance
JOIN pg_class AS child ON child.oid = inheritance.inhrelid
JOIN pg_roles AS owner ON owner.oid = child.relowner
WHERE inheritance.inhparent = 'logstream.logs'::regclass
  AND child.relname <> 'logs_default'
`);
        expect(inventory.rows).toHaveLength(1);
        expect(inventory.rows[0]).toMatchObject({
          name: expectedName,
          owner: "logstream_owner",
          runtime_select: false,
          runtime_insert: false,
          public_privileges: 0,
        });
        expect(inventory.rows[0]?.bound).toContain(reference.utcDay.slice(0, 10));

        const indexes = await runtime.query<{
          table_name: string;
          method: string;
          definition: string;
        }>(`
SELECT
  table_class.relname AS table_name,
  access_method.amname AS method,
  pg_get_indexdef(index_class.oid) AS definition
FROM pg_index AS index_metadata
JOIN pg_class AS index_class ON index_class.oid = index_metadata.indexrelid
JOIN pg_class AS table_class ON table_class.oid = index_metadata.indrelid
JOIN pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
JOIN pg_am AS access_method ON access_method.oid = index_class.relam
WHERE namespace.nspname = 'logstream'
ORDER BY table_class.relname, index_class.relname
`);
        expect(indexes.rows.filter((row) => row.table_name === expectedName)).toHaveLength(2);
        expect(indexes.rows.every((row) => row.method === "btree")).toBe(true);
        expect(indexes.rows.some((row) => /gin|trgm|level|message/iu.test(row.definition))).toBe(
          false,
        );
        expect(indexes.rows.filter((row) => row.table_name === "logs")).toHaveLength(2);
      });
    });

    it("rejects an unexpected relation-name collision without adopting it", async () => {
      const ownerUrl = databaseUrl(ownerBaseUrl ?? "", databaseName);
      const runtimeUrl = databaseUrl(runtimeBaseUrl ?? "", databaseName);
      await withClient(ownerUrl, async (owner) => {
        const reference = await databaseReference(owner);
        const name = buildPartitionPlan(new Date(reference.now), 1)[1]?.name;
        if (name === undefined) {
          throw new Error("Expected current partition name.");
        }
        await owner.query(
          `CREATE TABLE logstream.${trustedPartitionIdentifier(name)} (id integer)`,
        );

        await withClient(runtimeUrl, async (runtime) => {
          await expect(
            runtime.query("SELECT logstream.ensure_log_partition($1)", [reference.utcDay]),
          ).rejects.toMatchObject({ message: "Retention partition relation is invalid." });
        });

        const evidence = await owner.query<{ attached: boolean; columns: number }>(
          `
SELECT
  EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = $1::regclass) AS attached,
  (SELECT COUNT(*)::integer FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0) AS columns
`,
          [`logstream.${name}`],
        );
        expect(evidence.rows).toEqual([{ attached: false, columns: 1 }]);
      });
    });

    it("rejects an attached relation whose derived name has different bounds", async () => {
      const ownerUrl = databaseUrl(ownerBaseUrl ?? "", databaseName);
      const runtimeUrl = databaseUrl(runtimeBaseUrl ?? "", databaseName);
      await withClient(ownerUrl, async (owner) => {
        const reference = await databaseReference(owner);
        const name = buildPartitionPlan(new Date(reference.now), 1)[1]?.name;
        if (name === undefined) {
          throw new Error("Expected current partition name.");
        }
        const wrongStart = shift(reference.utcDay, 10 * 86_400_000);
        const wrongEnd = shift(reference.utcDay, 11 * 86_400_000);
        await owner.query(
          `CREATE TABLE logstream.${trustedPartitionIdentifier(name)} PARTITION OF logstream.logs FOR VALUES FROM (${trustedTimestampLiteral(wrongStart)}) TO (${trustedTimestampLiteral(wrongEnd)})`,
        );

        await withClient(runtimeUrl, async (runtime) => {
          await expect(
            runtime.query("SELECT logstream.ensure_log_partition($1)", [reference.utcDay]),
          ).rejects.toMatchObject({ message: "Retention partition relation is invalid." });
        });

        const evidence = await owner.query<{ bound: string }>(
          "SELECT pg_get_expr(relpartbound, oid) AS bound FROM pg_class WHERE oid = $1::regclass",
          [`logstream.${name}`],
        );
        expect(evidence.rows[0]?.bound).toContain(wrongStart.slice(0, 10));
      });
    });

    it("rejects and preserves a partitioned daily child while accepting an ordinary leaf", async () => {
      const ownerUrl = databaseUrl(ownerBaseUrl ?? "", databaseName);
      const runtimeUrl = databaseUrl(runtimeBaseUrl ?? "", databaseName);
      await withClient(ownerUrl, async (owner) => {
        const reference = await databaseReference(owner);
        const yesterday = shift(reference.utcDay, -86_400_000);
        const name = buildPartitionPlan(new Date(reference.now), 1)[0]?.name;
        if (name === undefined) {
          throw new Error("Expected previous-day partition name.");
        }
        const nestedName = `${name}_nested`;
        const partitionIdentifier = trustedPartitionIdentifier(name);
        const nestedIdentifier = trustedNestedPartitionIdentifier(nestedName);
        const startLiteral = trustedTimestampLiteral(yesterday);
        const endLiteral = trustedTimestampLiteral(reference.utcDay);
        const preservedId = "00000000-0000-4000-8000-000000000030";

        try {
          await owner.query(`
CREATE TABLE logstream.${partitionIdentifier}
PARTITION OF logstream.logs
FOR VALUES FROM (${startLiteral}) TO (${endLiteral})
PARTITION BY RANGE (timestamp);
CREATE TABLE logstream.${nestedIdentifier}
PARTITION OF logstream.${partitionIdentifier}
FOR VALUES FROM (${startLiteral}) TO (${endLiteral});
`);
          await insertLog(owner, shift(yesterday, 60 * 60 * 1_000), preservedId);

          const shape = await owner.query<{
            relispartition: boolean;
            relkind: string;
            child_relations: number;
          }>(
            `
SELECT
  relation.relispartition,
  relation.relkind,
  (
    SELECT COUNT(*)::integer
    FROM pg_inherits AS child_inheritance
    WHERE child_inheritance.inhparent = relation.oid
  ) AS child_relations
FROM pg_class AS relation
WHERE relation.oid = $1::regclass
`,
            [`logstream.${name}`],
          );
          expect(shape.rows).toEqual([{ relispartition: true, relkind: "p", child_relations: 1 }]);

          await withClient(runtimeUrl, async (runtime) => {
            await expect(
              runtime.query("SELECT logstream.ensure_log_partition($1)", [yesterday]),
            ).rejects.toMatchObject({ message: "Retention partition relation is invalid." });
            await expect(
              runtime.query<{ dropped: boolean }>(
                "SELECT logstream.drop_one_expired_log_partition($1) AS dropped",
                [reference.now],
              ),
            ).resolves.toMatchObject({ rows: [{ dropped: false }] });
          });

          const preserved = await owner.query<{
            outer_relation: string | null;
            nested_relation: string | null;
            row_count: number;
          }>(
            `
SELECT
  pg_catalog.to_regclass($1)::text AS outer_relation,
  pg_catalog.to_regclass($2)::text AS nested_relation,
  (
    SELECT COUNT(*)::integer
    FROM logstream.logs
    WHERE id = $3::uuid
  ) AS row_count
`,
            [`logstream.${name}`, `logstream.${nestedName}`, preservedId],
          );
          expect(preserved.rows).toEqual([
            {
              outer_relation: `logstream.${name}`,
              nested_relation: `logstream.${nestedName}`,
              row_count: 1,
            },
          ]);
        } finally {
          await owner.query(`DROP TABLE IF EXISTS logstream.${partitionIdentifier}`);
        }

        const cleaned = await owner.query<{
          outer_relation: string | null;
          nested_relation: string | null;
        }>(
          `
SELECT
  pg_catalog.to_regclass($1)::text AS outer_relation,
  pg_catalog.to_regclass($2)::text AS nested_relation
`,
          [`logstream.${name}`, `logstream.${nestedName}`],
        );
        expect(cleaned.rows).toEqual([{ outer_relation: null, nested_relation: null }]);

        await withClient(runtimeUrl, async (runtime) => {
          await expect(
            runtime.query<{ created: boolean }>(
              "SELECT logstream.ensure_log_partition($1) AS created",
              [yesterday],
            ),
          ).resolves.toMatchObject({ rows: [{ created: true }] });
          await expect(
            runtime.query<{ created: boolean }>(
              "SELECT logstream.ensure_log_partition($1) AS created",
              [yesterday],
            ),
          ).resolves.toMatchObject({ rows: [{ created: false }] });
          await expect(
            runtime.query<{ dropped: boolean }>(
              "SELECT logstream.drop_one_expired_log_partition($1) AS dropped",
              [reference.now],
            ),
          ).resolves.toMatchObject({ rows: [{ dropped: true }] });
        });

        const ordinaryLeaf = await owner.query<{ relation: string | null }>(
          "SELECT pg_catalog.to_regclass($1)::text AS relation",
          [`logstream.${name}`],
        );
        expect(ordinaryLeaf.rows).toEqual([{ relation: null }]);
      });
    });

    it("moves default overlap rows atomically and preserves every stored column", async () => {
      const runtimeUrl = databaseUrl(runtimeBaseUrl ?? "", databaseName);
      await withClient(runtimeUrl, async (runtime) => {
        const reference = await databaseReference(runtime);
        const timestamp = shift(reference.utcDay, 12 * 60 * 60 * 1_000);
        const createdAt = shift(reference.utcDay, 13 * 60 * 60 * 1_000);
        await insertLog(runtime, timestamp, "00000000-0000-4000-8000-000000000001", createdAt);
        const before = await runtime.query(
          "SELECT timestamp, id, level, service, message, attributes, attributes_search, created_at FROM logstream.logs",
        );

        await runtime.query("SELECT logstream.ensure_log_partition($1)", [reference.utcDay]);

        const after = await runtime.query(
          "SELECT timestamp, id, level, service, message, attributes, attributes_search, created_at FROM logstream.logs",
        );
        expect(after.rows).toEqual(before.rows);
        const routing = await runtime.query<{ relation: string }>(
          "SELECT tableoid::regclass::text AS relation FROM logstream.logs",
        );
        expect(routing.rows[0]?.relation).not.toBe("logstream.logs_default");
      });
    });

    it("rolls back child creation and row movement when the atomic path fails", async () => {
      const ownerUrl = databaseUrl(ownerBaseUrl ?? "", databaseName);
      const runtimeUrl = databaseUrl(runtimeBaseUrl ?? "", databaseName);
      await withClient(ownerUrl, async (owner) => {
        const reference = await databaseReference(owner);
        const name = buildPartitionPlan(new Date(reference.now), 1)[1]?.name;
        if (name === undefined) {
          throw new Error("Expected current partition name.");
        }
        await insertLog(
          owner,
          shift(reference.utcDay, 1_000),
          "00000000-0000-4000-8000-000000000002",
        );
        await owner.query(`
CREATE FUNCTION logstream.reject_retention_move() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'forced retention movement failure';
END
$$;
CREATE TRIGGER reject_retention_move
BEFORE DELETE ON logstream.logs_default
FOR EACH ROW EXECUTE FUNCTION logstream.reject_retention_move();
`);

        await withClient(runtimeUrl, async (runtime) => {
          await expect(
            runtime.query("SELECT logstream.ensure_log_partition($1)", [reference.utcDay]),
          ).rejects.toMatchObject({ message: "Retention partition relation is invalid." });
        });

        const evidence = await owner.query<{
          child: string | null;
          relation: string;
          count: number;
        }>(
          `
SELECT
  to_regclass($1)::text AS child,
  tableoid::regclass::text AS relation,
  COUNT(*)::integer AS count
FROM logstream.logs
GROUP BY tableoid
`,
          [`logstream.${name}`],
        );
        expect(evidence.rows).toEqual([
          { child: null, relation: "logstream.logs_default", count: 1 },
        ]);
      });
    });

    it("drops only one exact oldest expired daily child per call", async () => {
      await withClient(databaseUrl(runtimeBaseUrl ?? "", databaseName), async (runtime) => {
        const reference = await databaseReference(runtime);
        const yesterday = shift(reference.utcDay, -86_400_000);
        await runtime.query("SELECT logstream.ensure_log_partition($1)", [yesterday]);
        await runtime.query("SELECT logstream.ensure_log_partition($1)", [reference.utcDay]);

        await expect(
          runtime.query<{ dropped: boolean }>(
            "SELECT logstream.drop_one_expired_log_partition($1) AS dropped",
            [reference.now],
          ),
        ).resolves.toMatchObject({ rows: [{ dropped: true }] });
        await expect(
          runtime.query<{ dropped: boolean }>(
            "SELECT logstream.drop_one_expired_log_partition($1) AS dropped",
            [reference.now],
          ),
        ).resolves.toMatchObject({ rows: [{ dropped: false }] });

        const children = await runtime.query<{ name: string }>(`
SELECT child.relname AS name
FROM pg_inherits
JOIN pg_class AS child ON child.oid = inhrelid
WHERE inhparent = 'logstream.logs'::regclass
ORDER BY child.relname
`);
        expect(children.rows.map((row) => row.name)).toContain(
          buildPartitionPlan(new Date(reference.now), 1)[1]?.name,
        );
        expect(children.rows.map((row) => row.name)).not.toContain(
          buildPartitionPlan(new Date(reference.now), 1)[0]?.name,
        );
      });
    });

    it("deletes default rows in bounded batches and preserves cutoff equality", async () => {
      await withClient(databaseUrl(runtimeBaseUrl ?? "", databaseName), async (runtime) => {
        const reference = await databaseReference(runtime);
        const cutoff = shift(reference.now, -86_400_000);
        await insertLog(runtime, shift(cutoff, -1), "00000000-0000-4000-8000-000000000010");
        await insertLog(runtime, cutoff, "00000000-0000-4000-8000-000000000011");
        await insertLog(runtime, shift(cutoff, 1), "00000000-0000-4000-8000-000000000012");

        await expect(
          runtime.query<{ deleted: number }>(
            "SELECT logstream.delete_expired_default_logs($1, 1) AS deleted",
            [cutoff],
          ),
        ).resolves.toMatchObject({ rows: [{ deleted: 1 }] });
        await expect(
          runtime.query<{ deleted: number }>(
            "SELECT logstream.delete_expired_default_logs($1, 1) AS deleted",
            [cutoff],
          ),
        ).resolves.toMatchObject({ rows: [{ deleted: 0 }] });
        const remaining = await runtime.query<{ timestamp: Date }>(
          "SELECT timestamp FROM logstream.logs ORDER BY timestamp",
        );
        expect(remaining.rows.map((row) => row.timestamp.toISOString())).toEqual([
          cutoff,
          shift(cutoff, 1),
        ]);
      });
    });

    it("keeps runtime privileges narrow while allowing the repository to maintain data", async () => {
      const runtimeUrl = databaseUrl(runtimeBaseUrl ?? "", databaseName);
      await withClient(runtimeUrl, async (runtime) => {
        await expect(runtime.query("DELETE FROM logstream.logs")).rejects.toMatchObject({
          code: "42501",
        });
        await expect(runtime.query("TRUNCATE logstream.logs_default")).rejects.toMatchObject({
          code: "42501",
        });
        await expect(runtime.query("DROP TABLE logstream.logs_default")).rejects.toMatchObject({
          code: "42501",
        });
      });

      const pool = new Pool({ connectionString: runtimeUrl, max: 2 });
      try {
        const referenceClient = new Client({ connectionString: runtimeUrl });
        await referenceClient.connect();
        const reference = await databaseReference(referenceClient);
        await insertLog(
          referenceClient,
          shift(reference.now, -31 * 86_400_000),
          "00000000-0000-4000-8000-000000000020",
        );
        await referenceClient.end();

        const plan = buildPartitionPlan(new Date(reference.now), 1).slice(1);
        const repository = createRetentionRepository(runtimePoolAdapter(pool));
        const result = await repository.run({
          referenceTime: reference.now,
          cutoff: shift(reference.now, -30 * 86_400_000),
          partitions: plan,
          signal: new AbortController().signal,
        });

        expect(result).toEqual({
          status: "completed",
          partitionEnsureCalls: 3,
          partitionsCreated: 3,
          partitionDropCalls: 1,
          partitionsDropped: 0,
          defaultCleanupCalls: 1,
          defaultRowsDeleted: 1,
          partitionDropBudgetReached: false,
          defaultDeleteBudgetReached: false,
        });
        const count = await pool.query<{ count: number }>(
          "SELECT COUNT(*)::integer AS count FROM logstream.logs",
        );
        expect(count.rows).toEqual([{ count: 0 }]);

        const blocker = await pool.connect();
        try {
          await blocker.query("SELECT pg_advisory_lock($1, $2)", [1_815_642_963, 2]);
          await expect(
            repository.run({
              referenceTime: reference.now,
              cutoff: shift(reference.now, -30 * 86_400_000),
              partitions: plan,
              signal: new AbortController().signal,
            }),
          ).resolves.toMatchObject({ status: "skipped", partitionEnsureCalls: 0 });
        } finally {
          await blocker.query("SELECT pg_advisory_unlock($1, $2)", [1_815_642_963, 2]);
          blocker.release();
        }
      } finally {
        await pool.end();
      }
    });
  },
);
