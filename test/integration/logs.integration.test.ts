import { fileURLToPath } from "node:url";

import { Client, Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { loadMigrations } from "../../src/database/migrations/migration-loader.js";
import { runMigrationsWithOwnerRetry } from "../../src/database/migrations/migration-runner.js";
import type { MigrationOwnerConnection } from "../../src/database/migrations/migration-types.js";
import { buildPartitionPlan } from "../../src/database/partitions/partition-plan.js";
import { preparePartitions } from "../../src/database/partitions/partition-preparer.js";
import type { LogId } from "../../src/domain/log-entry.js";
import { createIngestionRepository } from "../../src/modules/ingestion/ingestion-repository.js";
import { createIngestionService } from "../../src/modules/ingestion/ingestion-service.js";

const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
const adminBaseUrl = process.env["TEST_ADMIN_DATABASE_URL"];
const ownerBaseUrl = process.env["TEST_OWNER_DATABASE_URL"];
const runtimeBaseUrl = process.env["TEST_RUNTIME_DATABASE_URL"];
const hasPostgresEnvironment =
  adminBaseUrl !== undefined && ownerBaseUrl !== undefined && runtimeBaseUrl !== undefined;
const fixedCurrentTime = new Date("2026-08-09T12:00:00.000Z");
const validTimestamp = "2026-08-09T11:00:00.000Z";
let databaseSequence = 0;
let databaseName = "";
let runtimePool: Pool | undefined;
let app: ReturnType<typeof buildApp> | undefined;

function databaseUrl(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function trustedDatabaseIdentifier(name: string): string {
  if (!/^logstream_logs_http_test_[0-9]+_[0-9]+$/u.test(name)) {
    throw new Error("Refusing an unexpected POST /logs test database identifier.");
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

function buildHttpApplication(generateId: () => LogId): ReturnType<typeof buildApp> {
  if (runtimePool === undefined) {
    throw new Error("Runtime pool was not created.");
  }

  const repository = createIngestionRepository(runtimePool);
  const ingestionService = createIngestionService({
    repository,
    clock: () => fixedCurrentTime.getTime(),
    generateId,
  });
  return buildApp({ ingestionService });
}

function sequentialIdGenerator(): () => LogId {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}` as LogId;
  };
}

describe.skipIf(!hasPostgresEnvironment)("POST /logs with PostgreSQL", () => {
  beforeEach(async () => {
    if (adminBaseUrl === undefined || runtimeBaseUrl === undefined) {
      throw new Error("PostgreSQL integration URLs are unavailable.");
    }

    databaseSequence += 1;
    databaseName = `logstream_logs_http_test_${String(process.pid)}_${String(databaseSequence)}`;
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
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }

    if (runtimePool !== undefined) {
      await runtimePool.end();
      runtimePool = undefined;
    }

    if (adminBaseUrl === undefined || databaseName.length === 0) {
      return;
    }

    await withClient(adminBaseUrl, async (admin) => {
      await admin.query(`DROP DATABASE ${trustedDatabaseIdentifier(databaseName)} WITH (FORCE)`);
    });
  });

  it("durably persists only accepted mixed-batch entries with safe attributes", async () => {
    if (runtimePool === undefined) {
      throw new Error("Runtime pool was not created.");
    }

    app = buildHttpApplication(sequentialIdGenerator());
    const injectionText = "checkout'); DROP TABLE logstream.logs; --";
    const payload = `{"ignoredTop":{"admin":true},"logs":[{"timestamp":"${validTimestamp}","level":"error","service":${JSON.stringify(injectionText)},"message":"first valid","attributes":{"":"empty","שלום":"unicode","__proto__":"prototype","constructor":"constructor","retries":3,"enabled":true},"ignoredEntry":{"admin":true}},{"timestamp":"${validTimestamp}","level":"info","service":"unsafe\\u0000service","message":"NUL invalid"},{"timestamp":"${validTimestamp}","level":"warn","service":"nested-invalid","message":"nested invalid","attributes":{"nested":{"unsafe":true}}},{"timestamp":"${validTimestamp}","level":"info","service":"ordinary","message":"second valid"}]}`;

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      headers: { "content-type": "application/json" },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accepted: 2,
      rejected: [
        { index: 1, reason: "service must not contain U+0000" },
        { index: 2, reason: "attribute values must be strings, finite numbers, or booleans" },
      ],
    });

    const stored = await runtimePool.query<{
      id: string;
      service: string;
      message: string;
      attributes: Record<string, unknown>;
      attributes_search: Record<string, string>;
    }>(`
SELECT id, service, message, attributes, attributes_search
FROM logstream.logs
ORDER BY id
`);
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows.map((row) => row.service)).toEqual([injectionText, "ordinary"]);
    expect(stored.rows.map((row) => row.message)).toEqual(["first valid", "second valid"]);
    const first = stored.rows[0];
    expect(first?.attributes[""]).toBe("empty");
    expect(first?.attributes["שלום"]).toBe("unicode");
    expect(first?.attributes["__proto__"]).toBe("prototype");
    expect(Reflect.get(first?.attributes ?? {}, "constructor")).toBe("constructor");
    expect(first?.attributes["retries"]).toBe(3);
    expect(first?.attributes["enabled"]).toBe(true);
    expect(first?.attributes_search["retries"]).toBe("3");
    expect(first?.attributes_search["enabled"]).toBe("true");
    expect(Object.hasOwn(first?.attributes ?? {}, "ignoredEntry")).toBe(false);

    const tableEvidence = await runtimePool.query<{ table_name: string | null; count: number }>(`
SELECT
  to_regclass('logstream.logs')::text AS table_name,
  (SELECT COUNT(*)::integer FROM logstream.logs) AS count
`);
    expect(tableEvidence.rows).toEqual([{ table_name: "logstream.logs", count: 2 }]);
  });

  it("returns 400 for an all-invalid batch without inserting rows", async () => {
    if (runtimePool === undefined) {
      throw new Error("Runtime pool was not created.");
    }

    app = buildHttpApplication(sequentialIdGenerator());

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: [{ timestamp: validTimestamp, level: "info", service: "", message: "invalid" }, null],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      accepted: 0,
      rejected: [
        { index: 0, reason: "service must be non-empty" },
        { index: 1, reason: "log entry must be a non-null object" },
      ],
    });

    const evidence = await runtimePool.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM logstream.logs",
    );
    expect(evidence.rows).toEqual([{ count: 0 }]);
  });

  it("returns generic 500 and rolls back the whole request after a genuine duplicate-ID failure", async () => {
    if (runtimePool === undefined) {
      throw new Error("Runtime pool was not created.");
    }

    const duplicateId = "00000000-0000-4000-8000-000000000999" as LogId;
    app = buildHttpApplication(() => duplicateId);
    const submittedSecret = "secret-service-value";

    const response = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: [
          {
            timestamp: validTimestamp,
            level: "info",
            service: submittedSecret,
            message: "first duplicate ID",
          },
          {
            timestamp: validTimestamp,
            level: "error",
            service: "second-service-value",
            message: "second duplicate ID",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('{"error":"Internal server error."}');
    expect(response.body).not.toContain("accepted");
    expect(response.body).not.toContain("23505");
    expect(response.body).not.toContain("duplicate key");
    expect(response.body).not.toContain("logstream.logs");
    expect(response.body).not.toContain(submittedSecret);
    expect(response.body).not.toContain("second-service-value");

    const evidence = await runtimePool.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM logstream.logs",
    );
    expect(evidence.rows).toEqual([{ count: 0 }]);
  });
});
