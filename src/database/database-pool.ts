import { Client, Pool } from "pg";

import type { DatabaseConfig } from "./database-config.js";
import type { MigrationOwnerConnection } from "./migrations/migration-types.js";

export type DatabasePool = Pool;
export type DatabaseProbe = () => Promise<void>;

export class RuntimeDatabaseVerificationError extends Error {
  public constructor() {
    super("The runtime database role or permissions are invalid.");
    this.name = "RuntimeDatabaseVerificationError";
  }
}

interface RuntimeVerificationRow {
  readonly role_name: string;
  readonly is_superuser: boolean;
  readonly can_use_application_schema: boolean;
  readonly can_create_in_application_schema: boolean;
  readonly can_use_migration_schema: boolean;
}

export interface RuntimeVerificationDatabase {
  query(sql: string): Promise<{
    readonly rowCount: number | null;
    readonly rows: readonly unknown[];
  }>;
}

const VERIFY_RUNTIME_SQL = `
SELECT
  current_user AS role_name,
  roles.rolsuper AS is_superuser,
  has_schema_privilege(current_user, 'logstream', 'USAGE') AS can_use_application_schema,
  has_schema_privilege(current_user, 'logstream', 'CREATE') AS can_create_in_application_schema,
  has_schema_privilege(current_user, 'logstream_migrations', 'USAGE') AS can_use_migration_schema
FROM pg_roles AS roles
WHERE roles.rolname = current_user
`;

export function createDatabasePool(config: DatabaseConfig): DatabasePool {
  return new Pool({
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    max: config.maxConnections,
    query_timeout: config.connectionTimeoutMs,
  });
}

export function createMigrationOwnerConnection(config: DatabaseConfig): MigrationOwnerConnection {
  const client = new Client({
    connectionString: config.migrationConnectionString,
    connectionTimeoutMillis: config.connectionTimeoutMs,
  });

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

export async function probeDatabase(pool: Pick<DatabasePool, "query">): Promise<void> {
  await pool.query("SELECT 1");
}

function isRuntimeVerificationRow(value: unknown): value is RuntimeVerificationRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return (
    "role_name" in value &&
    typeof value.role_name === "string" &&
    "is_superuser" in value &&
    typeof value.is_superuser === "boolean" &&
    "can_use_application_schema" in value &&
    typeof value.can_use_application_schema === "boolean" &&
    "can_create_in_application_schema" in value &&
    typeof value.can_create_in_application_schema === "boolean" &&
    "can_use_migration_schema" in value &&
    typeof value.can_use_migration_schema === "boolean"
  );
}

export async function verifyRuntimeDatabase(pool: RuntimeVerificationDatabase): Promise<void> {
  try {
    const result = await pool.query(VERIFY_RUNTIME_SQL);
    const candidate = result.rows[0];
    const row = isRuntimeVerificationRow(candidate) ? candidate : undefined;
    if (
      result.rowCount !== 1 ||
      row?.role_name !== "logstream_runtime" ||
      row.is_superuser ||
      !row.can_use_application_schema ||
      row.can_create_in_application_schema ||
      row.can_use_migration_schema
    ) {
      throw new RuntimeDatabaseVerificationError();
    }
  } catch (error: unknown) {
    if (error instanceof RuntimeDatabaseVerificationError) {
      throw error;
    }
    throw new RuntimeDatabaseVerificationError();
  }
}
