import { fileURLToPath } from "node:url";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InternalDatabaseError } from "../../src/database/database-errors.js";
import { loadMigrations } from "../../src/database/migrations/migration-loader.js";
import { runMigrationsWithOwnerRetry } from "../../src/database/migrations/migration-runner.js";
import type { MigrationOwnerConnection } from "../../src/database/migrations/migration-types.js";
import { buildPartitionPlan } from "../../src/database/partitions/partition-plan.js";
import { preparePartitions } from "../../src/database/partitions/partition-preparer.js";
import type { CanonicalUtcTimestamp, LogId, LogLevel } from "../../src/domain/log-entry.js";
import {
  createLogQueryRepository,
  type LogQueryRepository,
} from "../../src/modules/query/log-query-repository.js";
import { endPoolAndWaitForClients } from "../harness/postgres-pool-teardown.js";
import type { LogFilters } from "../../src/modules/query/query-parameter-parser.js";

const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
const adminBaseUrl = process.env["TEST_ADMIN_DATABASE_URL"];
const ownerBaseUrl = process.env["TEST_OWNER_DATABASE_URL"];
const runtimeBaseUrl = process.env["TEST_RUNTIME_DATABASE_URL"];
const hasPostgresEnvironment =
  adminBaseUrl !== undefined && ownerBaseUrl !== undefined && runtimeBaseUrl !== undefined;
const fixedCurrentTime = new Date("2026-08-09T12:00:00.000Z");
const databaseName = `logstream_query_repository_test_${String(process.pid)}`;

interface Fixture {
  readonly id: LogId;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly service: string;
  readonly message: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly attributesSearch: Readonly<Record<string, string>>;
}

function id(sequence: number): LogId {
  return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}` as LogId;
}

const fixtures: readonly Fixture[] = [
  {
    id: id(6),
    timestamp: "2026-08-09T11:00:00.123456Z",
    level: "error",
    service: "checkout",
    message: "Payment DECLINED literal % _ \\ path",
    attributes: JSON.parse(
      '{"":"empty","retries":3,"enabled":true,"__proto__":"prototype","constructor":"constructor","unicode-שלום":"ערך-世界","backslash-\\\\key":"value-\\\\path"}',
    ) as Record<string, string | number | boolean>,
    attributesSearch: JSON.parse(
      '{"":"empty","retries":"3","enabled":"true","__proto__":"prototype","constructor":"constructor","unicode-שלום":"ערך-世界","backslash-\\\\key":"value-\\\\path"}',
    ) as Record<string, string>,
  },
  {
    id: id(5),
    timestamp: "2026-08-09T11:00:00.123456Z",
    level: "warn",
    service: "checkout",
    message: "same timestamp lower UUID",
    attributes: { retries: 3, enabled: false },
    attributesSearch: { retries: "3", enabled: "false" },
  },
  {
    id: id(4),
    timestamp: "2026-08-09T11:00:00.123455Z",
    level: "info",
    service: "auth",
    message: "authentication event",
    attributes: { retries: "03" },
    attributesSearch: { retries: "03" },
  },
  {
    id: id(3),
    timestamp: "2026-08-09T11:00:00.123400Z",
    level: "info",
    service: "checkout",
    message: "omitted attributes fixture",
    attributes: {},
    attributesSearch: {},
  },
  {
    id: id(2),
    timestamp: "2026-08-09T10:30:00.000000Z",
    level: "debug",
    service: "worker",
    message: "ordinary worker event",
    attributes: { negative_zero: 0 },
    attributesSearch: { negative_zero: "0" },
  },
  {
    id: id(1),
    timestamp: "2026-08-09T10:00:00.000000Z",
    level: "error",
    service: "billing",
    message: "old billing event",
    attributes: { enabled: true },
    attributesSearch: { enabled: "true" },
  },
];

function databaseUrl(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function trustedDatabaseIdentifier(name: string): string {
  if (!/^logstream_query_repository_test_[0-9]+$/u.test(name)) {
    throw new Error("Refusing an unexpected query-repository test database identifier.");
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

function filters(overrides: Partial<LogFilters> = {}): LogFilters {
  return { attributes: [], ...overrides };
}

async function insertFixtures(ownerUrl: string): Promise<void> {
  await withClient(ownerUrl, async (owner) => {
    for (const fixture of fixtures) {
      await owner.query(
        `
INSERT INTO logstream.logs (
  timestamp, id, level, service, message, attributes, attributes_search
)
VALUES ($1::timestamptz, $2::uuid, $3::text, $4::text, $5::text, $6::jsonb, $7::jsonb)
`,
        [
          fixture.timestamp,
          fixture.id,
          fixture.level,
          fixture.service,
          fixture.message,
          JSON.stringify(fixture.attributes),
          JSON.stringify(fixture.attributesSearch),
        ],
      );
    }
  });
}

describe.skipIf(!hasPostgresEnvironment)("log query repository with PostgreSQL", () => {
  let runtimePool: Pool;
  let repository: LogQueryRepository;
  let ownerUrl: string;

  beforeAll(async () => {
    if (adminBaseUrl === undefined || ownerBaseUrl === undefined || runtimeBaseUrl === undefined) {
      throw new Error("PostgreSQL integration URLs are unavailable.");
    }

    await withClient(adminBaseUrl, async (admin) => {
      await admin.query(
        `CREATE DATABASE ${trustedDatabaseIdentifier(databaseName)} OWNER logstream_owner TEMPLATE template0`,
      );
    });
    ownerUrl = databaseUrl(ownerBaseUrl, databaseName);
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
    await insertFixtures(ownerUrl);
    runtimePool = new Pool({ connectionString: databaseUrl(runtimeBaseUrl, databaseName), max: 2 });
    repository = createLogQueryRepository(runtimePool);
  });

  afterAll(async () => {
    await endPoolAndWaitForClients(runtimePool);
    if (adminBaseUrl !== undefined) {
      await withClient(adminBaseUrl, async (admin) => {
        await admin.query(`DROP DATABASE ${trustedDatabaseIdentifier(databaseName)} WITH (FORCE)`);
      });
    }
  });

  it("queries as the restricted runtime role and returns only public fields", async () => {
    const role = await runtimePool.query<{ current_user: string }>("SELECT current_user");
    expect(role.rows).toEqual([{ current_user: "logstream_runtime" }]);

    const page = await repository.findPage({ filters: filters(), limit: 10 });

    expect(page).toHaveLength(fixtures.length);
    expect(Object.keys(page[0] ?? {})).toEqual([
      "id",
      "timestamp",
      "level",
      "service",
      "message",
      "attributes",
    ]);
    expect(Object.hasOwn(page[0] ?? {}, "attributes_search")).toBe(false);
    expect(Object.hasOwn(page[0] ?? {}, "created_at")).toBe(false);
  });

  it("paginates timestamp and UUID tuples without losing microsecond-distinct rows", async () => {
    const seen: LogId[] = [];
    let position: { readonly timestamp: CanonicalUtcTimestamp; readonly id: LogId } | undefined;

    for (;;) {
      const page = await repository.findPage({
        filters: filters(),
        limit: 2,
        ...(position === undefined ? {} : { cursor: position }),
      });
      const returned = page.slice(0, 2);
      seen.push(...returned.map((row) => row.id));
      if (page.length <= 2) {
        break;
      }
      const last = returned.at(-1);
      if (last === undefined) {
        throw new Error("Expected a non-empty continuation page.");
      }
      position = { timestamp: last.timestamp, id: last.id };
    }

    expect(seen).toEqual(fixtures.map((fixture) => fixture.id));
    expect(new Set(seen).size).toBe(fixtures.length);
    const first = await repository.findPage({ filters: filters(), limit: 3 });
    expect(first.map((row) => row.timestamp)).toEqual([
      "2026-08-09T11:00:00.123456Z",
      "2026-08-09T11:00:00.123456Z",
      "2026-08-09T11:00:00.123455Z",
      "2026-08-09T11:00:00.1234Z",
    ]);
  });

  it("executes every approved filter together and preserves half-open bounds", async () => {
    const combined = await repository.findPage({
      filters: filters({
        service: "checkout",
        level: "error",
        since: "2026-08-09T11:00:00.123456Z" as CanonicalUtcTimestamp,
        until: "2026-08-09T11:00:00.123457Z" as CanonicalUtcTimestamp,
        attributes: [
          { key: "retries", value: "3" },
          { key: "enabled", value: "true" },
        ],
        q: "payment declined",
      }),
      limit: 10,
    });
    expect(combined.map((row) => row.id)).toEqual([id(6)]);

    await expect(
      repository.findPage({ filters: filters({ service: "missing" }), limit: 10 }),
    ).resolves.toEqual([]);
    await expect(
      repository.findPage({ filters: filters({ level: "info", service: "checkout" }), limit: 10 }),
    ).resolves.toMatchObject([{ id: id(3) }]);
    await expect(
      repository.findPage({
        filters: filters({
          since: "2026-08-09T11:00:00.123456Z" as CanonicalUtcTimestamp,
          until: "2026-08-09T11:00:00.123456Z" as CanonicalUtcTimestamp,
        }),
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  it("applies attribute AND/string semantics and literal case-insensitive q semantics", async () => {
    await expect(
      repository.findPage({
        filters: filters({
          attributes: [
            { key: "retries", value: "3" },
            { key: "enabled", value: "true" },
          ],
        }),
        limit: 10,
      }),
    ).resolves.toMatchObject([{ id: id(6) }]);
    await expect(
      repository.findPage({
        filters: filters({ attributes: [{ key: "retries", value: "03" }] }),
        limit: 10,
      }),
    ).resolves.toMatchObject([{ id: id(4) }]);
    await expect(
      repository.findPage({ filters: filters({ q: "% _ \\" }), limit: 10 }),
    ).resolves.toMatchObject([{ id: id(6) }]);
  });

  it("keeps Unicode, backslash, and prototype-sensitive attributes as safe matching data", async () => {
    const page = await repository.findPage({
      filters: filters({
        attributes: [
          { key: "unicode-שלום", value: "ערך-世界" },
          { key: "backslash-\\key", value: "value-\\path" },
          { key: "__proto__", value: "prototype" },
          { key: "constructor", value: "constructor" },
        ],
      }),
      limit: 10,
    });

    expect(page).toHaveLength(1);
    const attributes = page[0]?.attributes;
    expect(Object.getPrototypeOf(attributes)).toBeNull();
    expect(attributes?.["__proto__"]).toBe("prototype");
    expect(Reflect.get(attributes ?? {}, "constructor")).toBe("constructor");
    expect(attributes?.["unicode-שלום"]).toBe("ערך-世界");
    expect(attributes?.["backslash-\\key"]).toBe("value-\\path");
    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();
  });

  it("keeps injection payloads as data and leaves the table intact", async () => {
    const injection = "checkout'); DROP TABLE logstream.logs; --";
    await expect(
      repository.findPage({
        filters: filters({
          service: injection,
          attributes: [{ key: 'key"} OR TRUE --', value: "anything" }],
          q: "%' OR TRUE --",
        }),
        limit: 10,
      }),
    ).resolves.toEqual([]);

    const evidence = await runtimePool.query<{ table_name: string; count: number }>(`
SELECT
  to_regclass('logstream.logs')::text AS table_name,
  (SELECT COUNT(*)::integer FROM logstream.logs) AS count
`);
    expect(evidence.rows).toEqual([{ table_name: "logstream.logs", count: fixtures.length }]);
  });

  it("rejects a storage row outside the approved UUID contract without exposing it", async () => {
    const invalidId = "00000000-0000-1000-8000-000000000999";
    await withClient(ownerUrl, async (owner) => {
      await owner.query(
        `
INSERT INTO logstream.logs (timestamp, id, level, service, message)
VALUES ('2026-08-09T11:30:00Z'::timestamptz, $1::uuid, 'info', 'invalid-row', 'secret-row')
`,
        [invalidId],
      );
    });

    let thrown: unknown;
    try {
      await repository.findPage({ filters: filters({ service: "invalid-row" }), limit: 10 });
    } catch (error: unknown) {
      thrown = error;
    } finally {
      await withClient(ownerUrl, async (owner) => {
        await owner.query("DELETE FROM logstream.logs WHERE id = $1::uuid", [invalidId]);
      });
    }

    expect(thrown).toBeInstanceOf(InternalDatabaseError);
    expect(String(thrown)).not.toContain(invalidId);
    expect(String(thrown)).not.toContain("secret-row");
  });
});
