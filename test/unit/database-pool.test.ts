import { describe, expect, it, vi } from "vitest";

import {
  createDatabasePool,
  RuntimeDatabaseVerificationError,
  verifyRuntimeDatabase,
} from "../../src/database/database-pool.js";
import { loadDatabaseConfig } from "../../src/database/database-config.js";

describe("createDatabasePool", () => {
  it("configures connection and query timeouts independently", async () => {
    const pool = createDatabasePool(
      loadDatabaseConfig({
        DB_CONNECTION_TIMEOUT_MS: "1500",
        DB_QUERY_TIMEOUT_MS: "12000",
      }),
    );

    try {
      const options = pool.options as typeof pool.options & { readonly query_timeout: number };
      expect(options.connectionTimeoutMillis).toBe(1_500);
      expect(options.query_timeout).toBe(12_000);
    } finally {
      await pool.end();
    }
  });
});

function verifiedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role_name: "logstream_runtime",
    is_superuser: false,
    can_use_application_schema: true,
    can_create_in_application_schema: false,
    can_use_migration_schema: false,
    ...overrides,
  };
}

describe("verifyRuntimeDatabase", () => {
  it("accepts the restricted runtime baseline", async () => {
    const query = vi.fn(() => Promise.resolve({ rowCount: 1, rows: [verifiedRow()] }));

    await expect(verifyRuntimeDatabase({ query })).resolves.toBeUndefined();
  });

  it.each([
    { role_name: "logstream_owner" },
    { is_superuser: true },
    { can_use_application_schema: false },
    { can_create_in_application_schema: true },
    { can_use_migration_schema: true },
  ])("rejects an invalid runtime identity or privilege: %o", async (override) => {
    const query = vi.fn(() => Promise.resolve({ rowCount: 1, rows: [verifiedRow(override)] }));

    await expect(verifyRuntimeDatabase({ query })).rejects.toBeInstanceOf(
      RuntimeDatabaseVerificationError,
    );
  });

  it("sanitizes database verification errors", async () => {
    const secret = "secret-runtime-password";
    const query = vi.fn(() => Promise.reject(new Error(secret)));

    try {
      await verifyRuntimeDatabase({ query });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RuntimeDatabaseVerificationError);
      expect(String(error)).not.toContain(secret);
    }
  });
});
