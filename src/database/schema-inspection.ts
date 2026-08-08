import { loadDatabaseConfig } from "./database-config.js";
import { createDatabasePool } from "./database-pool.js";

const COLUMNS_SQL = `
SELECT
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'logstream'
  AND table_name = 'logs'
ORDER BY ordinal_position
`;
const CONSTRAINTS_SQL = `
SELECT
  constraint_object.conname AS constraint_name,
  constraint_object.contype AS constraint_type,
  pg_get_constraintdef(constraint_object.oid) AS definition
FROM pg_constraint AS constraint_object
WHERE constraint_object.conrelid = 'logstream.logs'::regclass
ORDER BY constraint_object.conname
`;
const PARTITIONS_SQL = `
SELECT
  parent.relname AS parent,
  child.relname AS child,
  owner_role.rolname AS owner,
  pg_get_expr(child.relpartbound, child.oid) AS bound
FROM pg_inherits AS inheritance
JOIN pg_class AS parent ON parent.oid = inheritance.inhparent
JOIN pg_namespace AS namespace ON namespace.oid = parent.relnamespace
JOIN pg_class AS child ON child.oid = inheritance.inhrelid
JOIN pg_roles AS owner_role ON owner_role.oid = child.relowner
WHERE namespace.nspname = 'logstream'
  AND parent.relname = 'logs'
ORDER BY child.relname
`;
const INDEXES_SQL = `
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'logstream'
  AND (
    tablename = 'logs'
    OR tablename LIKE 'logs\\_%' ESCAPE '\\'
  )
ORDER BY tablename, indexname
`;
const SUMMARY_SQL = `
SELECT
  pg_get_partkeydef('logstream.logs'::regclass) AS partition_key,
  owner_role.rolname AS parent_owner,
  current_user AS inspected_as,
  has_schema_privilege(current_user, 'logstream', 'USAGE') AS schema_usage,
  has_schema_privilege(current_user, 'logstream', 'CREATE') AS schema_create,
  has_table_privilege(current_user, 'logstream.logs', 'SELECT') AS logs_select,
  has_table_privilege(current_user, 'logstream.logs', 'INSERT') AS logs_insert
FROM pg_class AS parent
JOIN pg_roles AS owner_role ON owner_role.oid = parent.relowner
WHERE parent.oid = 'logstream.logs'::regclass
`;

async function main(): Promise<void> {
  const config = loadDatabaseConfig(process.env);
  const pool = createDatabasePool(config);
  try {
    const columns = await pool.query(COLUMNS_SQL);
    const constraints = await pool.query(CONSTRAINTS_SQL);
    const partitions = await pool.query(PARTITIONS_SQL);
    const indexes = await pool.query(INDEXES_SQL);
    const summary = await pool.query(SUMMARY_SQL);
    process.stdout.write(
      `${JSON.stringify(
        {
          summary: summary.rows,
          columns: columns.rows,
          constraints: constraints.rows,
          partitions: partitions.rows,
          indexes: indexes.rows,
        },
        undefined,
        2,
      )}\n`,
    );
  } finally {
    await pool.end();
  }
}

void main().catch(() => {
  process.stderr.write("Schema inspection failed.\n");
  process.exitCode = 1;
});
