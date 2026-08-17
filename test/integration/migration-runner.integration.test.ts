import { fileURLToPath } from "node:url";

import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMigrations } from "../../src/database/migrations/migration-loader.js";
import {
  MigrationChecksumMismatchError,
  MigrationExecutionError,
} from "../../src/database/migrations/migration-errors.js";
import {
  runMigrations,
  runMigrationsWithOwner,
} from "../../src/database/migrations/migration-runner.js";
import type {
  MigrationDatabase,
  MigrationFile,
  MigrationOwnerConnection,
} from "../../src/database/migrations/migration-types.js";

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
  if (!/^logstream_migration_test_[0-9]+_[0-9]+$/u.test(name)) {
    throw new Error("Refusing an unexpected integration database identifier.");
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

async function applyProductionMigrations(name = databaseName) {
  if (ownerBaseUrl === undefined) {
    throw new Error("Owner test URL is unavailable.");
  }
  return runMigrationsWithOwner({
    connection: ownerConnection(databaseUrl(ownerBaseUrl, name)),
    loadMigrations: async () => loadMigrations(migrationsDirectory),
  });
}

describe.skipIf(!hasPostgresEnvironment)("migration runner with PostgreSQL", () => {
  beforeEach(async () => {
    if (adminBaseUrl === undefined) {
      throw new Error("Admin test URL is unavailable.");
    }
    databaseSequence += 1;
    databaseName = `logstream_migration_test_${String(process.pid)}_${String(databaseSequence)}`;
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

  it("applies every production migration and records exact identities and checksums", async () => {
    const result = await applyProductionMigrations();
    const expected = await loadMigrations(migrationsDirectory);
    const ownerUrl = databaseUrl(ownerBaseUrl ?? "", databaseName);

    expect(result).toEqual({ appliedVersions: expected.map((migration) => migration.version) });
    await withClient(ownerUrl, async (owner) => {
      const history = await owner.query<{
        version: number;
        filename: string;
        checksum: string;
        applied_at: Date;
      }>(
        "SELECT version, filename, checksum, applied_at FROM logstream_migrations.schema_migrations",
      );
      expect(history.rows).toHaveLength(expected.length);
      expect(
        history.rows.map(({ version, filename, checksum }) => ({ version, filename, checksum })),
      ).toEqual(
        expected.map(({ version, filename, checksum }) => ({ version, filename, checksum })),
      );
      expect(history.rows.every((row) => row.applied_at instanceof Date)).toBe(true);
    });
  });

  it("validates a repeat run without reapplying production migrations", async () => {
    await applyProductionMigrations();

    await expect(applyProductionMigrations()).resolves.toEqual({ appliedVersions: [] });
  });

  it("makes logstream_owner the application schema owner", async () => {
    await applyProductionMigrations();
    await withClient(databaseUrl(adminBaseUrl ?? "", databaseName), async (admin) => {
      const result = await admin.query<{ owner_name: string }>(`
SELECT roles.rolname AS owner_name
FROM pg_namespace AS namespaces
JOIN pg_roles AS roles ON roles.oid = namespaces.nspowner
WHERE namespaces.nspname = 'logstream'
`);
      expect(result.rows).toEqual([{ owner_name: "logstream_owner" }]);
    });
  });

  it("removes PUBLIC privileges from application and migration schemas", async () => {
    await applyProductionMigrations();
    await withClient(databaseUrl(adminBaseUrl ?? "", databaseName), async (admin) => {
      const result = await admin.query<{ public_privilege_count: number }>(`
SELECT COUNT(*)::integer AS public_privilege_count
FROM pg_namespace AS namespaces
CROSS JOIN LATERAL aclexplode(
  COALESCE(namespaces.nspacl, acldefault('n', namespaces.nspowner))
) AS privileges
WHERE namespaces.nspname IN ('logstream', 'logstream_migrations')
  AND privileges.grantee = 0
`);
      expect(result.rows[0]?.public_privilege_count).toBe(0);
    });
  });

  it("keeps both application database roles non-superuser", async () => {
    await applyProductionMigrations();
    await withClient(databaseUrl(adminBaseUrl ?? "", databaseName), async (admin) => {
      const result = await admin.query<{ rolname: string; rolsuper: boolean }>(`
SELECT rolname, rolsuper
FROM pg_roles
WHERE rolname IN ('logstream_owner', 'logstream_runtime')
ORDER BY rolname
`);
      expect(result.rows).toEqual([
        { rolname: "logstream_owner", rolsuper: false },
        { rolname: "logstream_runtime", rolsuper: false },
      ]);
    });
  });

  it("installs only the three hardened retention routine signatures", async () => {
    await applyProductionMigrations();
    await withClient(databaseUrl(adminBaseUrl ?? "", databaseName), async (admin) => {
      const routines = await admin.query<{
        signature: string;
        owner: string;
        security_definer: boolean;
        configuration: string[] | null;
        runtime_execute: boolean;
        public_execute_count: number;
      }>(`
SELECT
  routine.oid::regprocedure::text AS signature,
  owner.rolname AS owner,
  routine.prosecdef AS security_definer,
  routine.proconfig AS configuration,
  has_function_privilege('logstream_runtime', routine.oid, 'EXECUTE') AS runtime_execute,
  (
    SELECT COUNT(*)::integer
    FROM aclexplode(COALESCE(routine.proacl, acldefault('f', routine.proowner))) AS privilege
    WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
  ) AS public_execute_count
FROM pg_proc AS routine
JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
JOIN pg_roles AS owner ON owner.oid = routine.proowner
WHERE namespace.nspname = 'logstream'
ORDER BY signature
`);

      expect(routines.rows).toEqual([
        {
          signature: "logstream.delete_expired_default_logs(timestamp with time zone,integer)",
          owner: "logstream_owner",
          security_definer: true,
          configuration: ["search_path=pg_catalog, pg_temp"],
          runtime_execute: true,
          public_execute_count: 0,
        },
        {
          signature: "logstream.drop_one_expired_log_partition(timestamp with time zone)",
          owner: "logstream_owner",
          security_definer: true,
          configuration: ["search_path=pg_catalog, pg_temp"],
          runtime_execute: true,
          public_execute_count: 0,
        },
        {
          signature: "logstream.ensure_log_partition(timestamp with time zone)",
          owner: "logstream_owner",
          security_definer: true,
          configuration: ["search_path=pg_catalog, pg_temp"],
          runtime_execute: true,
          public_execute_count: 0,
        },
      ]);
    });
  });

  it("adds only the approved message-search index family and pg_trgm extension", async () => {
    await applyProductionMigrations();
    await withClient(databaseUrl(adminBaseUrl ?? "", databaseName), async (admin) => {
      const relations = await admin.query<{ name: string; kind: string }>(`
SELECT class.relname AS name, class.relkind AS kind
FROM pg_class AS class
JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
WHERE namespace.nspname = 'logstream'
ORDER BY class.relname
`);
      expect(relations.rows.map((row) => row.name)).toEqual([
        "logs",
        "logs_default",
        "logs_default_message_idx",
        "logs_default_pkey",
        "logs_default_service_timestamp_id_idx",
        "logs_message_trgm_idx",
        "logs_pkey",
        "logs_service_timestamp_id_idx",
      ]);
      const extensions = await admin.query<{ name: string }>(
        "SELECT extname AS name FROM pg_extension ORDER BY extname",
      );
      expect(extensions.rows).toEqual([{ name: "pg_trgm" }, { name: "plpgsql" }]);
    });
  });

  it("allows runtime connection and application schema usage only", async () => {
    await applyProductionMigrations();
    await withClient(databaseUrl(runtimeBaseUrl ?? "", databaseName), async (runtime) => {
      const result = await runtime.query<{
        role_name: string;
        can_use: boolean;
        can_create: boolean;
        can_use_migrations: boolean;
      }>(`
SELECT
  current_user AS role_name,
  has_schema_privilege(current_user, 'logstream', 'USAGE') AS can_use,
  has_schema_privilege(current_user, 'logstream', 'CREATE') AS can_create,
  has_schema_privilege(current_user, 'logstream_migrations', 'USAGE') AS can_use_migrations
`);
      expect(result.rows).toEqual([
        {
          role_name: "logstream_runtime",
          can_use: true,
          can_create: false,
          can_use_migrations: false,
        },
      ]);
    });
  });

  it("prevents runtime from creating arbitrary application objects", async () => {
    await applyProductionMigrations();
    await withClient(databaseUrl(runtimeBaseUrl ?? "", databaseName), async (runtime) => {
      await expect(
        runtime.query("CREATE TABLE logstream.forbidden (id integer)"),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("prevents runtime from reading or mutating migration history", async () => {
    await applyProductionMigrations();
    await withClient(databaseUrl(runtimeBaseUrl ?? "", databaseName), async (runtime) => {
      await expect(
        runtime.query("SELECT version FROM logstream_migrations.schema_migrations"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtime.query(
          "INSERT INTO logstream_migrations.schema_migrations (version, filename, checksum) VALUES (99, 'forbidden.sql', $1)",
          ["f".repeat(64)],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("rolls back failed DDL and its history row", async () => {
    const ownerUrl = databaseUrl(ownerBaseUrl ?? "", databaseName);
    const client = new Client({ connectionString: ownerUrl });
    await client.connect();
    const failedMigration: MigrationFile = {
      version: 1,
      filename: "0001_failure_probe.sql",
      checksum: "a".repeat(64),
      sql: "CREATE SCHEMA rollback_probe; SELECT 1 / 0;",
    };

    await expect(
      runMigrations({
        database: databaseAdapter(client),
        loadMigrations: () => Promise.resolve([failedMigration]),
      }),
    ).rejects.toBeInstanceOf(MigrationExecutionError);
    const evidence = await client.query<{ schema_name: string | null; history_count: number }>(`
SELECT
  to_regnamespace('rollback_probe')::text AS schema_name,
  (SELECT COUNT(*)::integer FROM logstream_migrations.schema_migrations) AS history_count
`);
    expect(evidence.rows).toEqual([{ schema_name: null, history_count: 0 }]);
    await client.end();
  });

  it("rejects a checksum mismatch on an already applied migration", async () => {
    await applyProductionMigrations();
    const [productionMigration] = await loadMigrations(migrationsDirectory);
    if (productionMigration === undefined) {
      throw new Error("Production migration is missing.");
    }
    const changedMigration = { ...productionMigration, checksum: "f".repeat(64) };
    const client = new Client({ connectionString: databaseUrl(ownerBaseUrl ?? "", databaseName) });
    await client.connect();

    await expect(
      runMigrations({
        database: databaseAdapter(client),
        loadMigrations: () => Promise.resolve([changedMigration]),
      }),
    ).rejects.toBeInstanceOf(MigrationChecksumMismatchError);
    await client.end();
  });

  it("waits for an owner session to release the advisory migration lock", async () => {
    const ownerUrl = databaseUrl(ownerBaseUrl ?? "", databaseName);
    const blocker = new Client({ connectionString: ownerUrl });
    await blocker.connect();
    await blocker.query("SELECT pg_advisory_lock($1, $2)", [1_815_642_963, 1]);
    let lockReleased = false;

    try {
      const operation = runMigrationsWithOwner({
        connection: ownerConnection(ownerUrl),
        loadMigrations: async () => loadMigrations(migrationsDirectory),
        lock: {
          deadline: Date.now() + 2_000,
          retryDelayMs: 20,
        },
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      await withClient(databaseUrl(adminBaseUrl ?? "", databaseName), async (admin) => {
        const beforeRelease = await admin.query<{ application_schema: string | null }>(
          "SELECT to_regnamespace('logstream')::text AS application_schema",
        );
        expect(beforeRelease.rows).toEqual([{ application_schema: null }]);
      });

      await blocker.query("SELECT pg_advisory_unlock($1, $2)", [1_815_642_963, 1]);
      lockReleased = true;
      await expect(operation).resolves.toEqual({ appliedVersions: [1, 2, 3, 4] });
    } finally {
      if (!lockReleased) {
        await blocker.query("SELECT pg_advisory_unlock($1, $2)", [1_815_642_963, 1]);
      }
      await blocker.end();
    }
  });

  it("serializes concurrent runners and records each production migration once", async () => {
    const ownerUrl = databaseUrl(ownerBaseUrl ?? "", databaseName);
    const first = ownerConnection(ownerUrl);
    const second = ownerConnection(ownerUrl);
    const load = async () => loadMigrations(migrationsDirectory);

    const results = await Promise.all([
      runMigrationsWithOwner({ connection: first, loadMigrations: load }),
      runMigrationsWithOwner({ connection: second, loadMigrations: load }),
    ]);

    expect(results.map((result) => result.appliedVersions).toSorted()).toEqual([[], [1, 2, 3, 4]]);
    await withClient(ownerUrl, async (owner) => {
      const history = await owner.query<{ count: number }>(
        "SELECT COUNT(*)::integer AS count FROM logstream_migrations.schema_migrations",
      );
      expect(history.rows).toEqual([{ count: 4 }]);
    });
  });
});
