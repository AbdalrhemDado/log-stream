import { Pool } from "pg";

import type { DatabaseConfig } from "./database-config.js";

export type DatabasePool = Pool;
export type DatabaseProbe = () => Promise<void>;

export function createDatabasePool(config: DatabaseConfig): DatabasePool {
  return new Pool({
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    max: config.maxConnections,
    query_timeout: config.connectionTimeoutMs,
  });
}

export async function probeDatabase(pool: Pick<DatabasePool, "query">): Promise<void> {
  await pool.query("SELECT 1");
}
