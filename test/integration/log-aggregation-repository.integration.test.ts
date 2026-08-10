import { fileURLToPath } from "node:url";

import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadMigrations } from "../../src/database/migrations/migration-loader.js";
import { runMigrationsWithOwnerRetry } from "../../src/database/migrations/migration-runner.js";
import type { MigrationOwnerConnection } from "../../src/database/migrations/migration-types.js";
import { buildPartitionPlan } from "../../src/database/partitions/partition-plan.js";
import { preparePartitions } from "../../src/database/partitions/partition-preparer.js";
import type { LogId, LogLevel } from "../../src/domain/log-entry.js";
import {
  parseLogAggregationQuery,
  type ParsedLogAggregationQuery,
} from "../../src/modules/aggregation/aggregation-parameter-parser.js";
import {
  createLogAggregationRepository,
  type LogAggregationRepository,
} from "../../src/modules/aggregation/log-aggregation-repository.js";

const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
const adminBaseUrl = process.env["TEST_ADMIN_DATABASE_URL"];
const ownerBaseUrl = process.env["TEST_OWNER_DATABASE_URL"];
const runtimeBaseUrl = process.env["TEST_RUNTIME_DATABASE_URL"];
const hasPostgresEnvironment =
  adminBaseUrl !== undefined && ownerBaseUrl !== undefined && runtimeBaseUrl !== undefined;
const fixedCurrentTime = new Date("2026-08-09T12:00:00.000Z");
const databaseName = `logstream_aggregation_repository_test_${String(process.pid)}`;

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
    id: id(1),
    timestamp: "2026-08-09T10:00:00.000000Z",
    level: "error",
    service: "checkout",
    message: "Payment DECLINED literal % _ \\ path",
    attributes: JSON.parse(
      '{"":"empty","retries":3,"enabled":true,"__proto__":"prototype","constructor":"constructor","toString":"to-string","unicode-שלום":"ערך-世界","backslash-\\\\key":"value-\\\\path"}',
    ) as Record<string, string | number | boolean>,
    attributesSearch: JSON.parse(
      '{"":"empty","retries":"3","enabled":"true","__proto__":"prototype","constructor":"constructor","toString":"to-string","unicode-שלום":"ערך-世界","backslash-\\\\key":"value-\\\\path"}',
    ) as Record<string, string>,
  },
  {
    id: id(2),
    timestamp: "2026-08-09T10:00:59.999999Z",
    level: "error",
    service: "checkout",
    message: "same first minute",
    attributes: { retries: 3, enabled: false },
    attributesSearch: { retries: "3", enabled: "false" },
  },
  {
    id: id(3),
    timestamp: "2026-08-09T10:01:00.000000Z",
    level: "info",
    service: "auth",
    message: "next minute",
    attributes: { retries: "03" },
    attributesSearch: { retries: "03" },
  },
  {
    id: id(4),
    timestamp: "2026-08-09T10:04:59.999999Z",
    level: "warn",
    service: "checkout",
    message: "last instant in five-minute bucket",
    attributes: { retries: 3 },
    attributesSearch: { retries: "3" },
  },
  {
    id: id(5),
    timestamp: "2026-08-09T10:05:00.000000Z",
    level: "debug",
    service: "worker",
    message: "next five-minute bucket",
    attributes: {},
    attributesSearch: {},
  },
  {
    id: id(6),
    timestamp: "2026-08-09T11:00:00.000000Z",
    level: "info",
    service: "__proto__",
    message: "prototype group value",
    attributes: { constructor: "safe" },
    attributesSearch: { constructor: "safe" },
  },
  {
    id: id(7),
    timestamp: "2026-08-09T12:00:00.000000Z",
    level: "error",
    service: "exclusive",
    message: "exclusive until boundary",
    attributes: {},
    attributesSearch: {},
  },
  {
    id: id(8),
    timestamp: "1969-12-31T23:59:59.999999Z",
    level: "info",
    service: "epoch",
    message: "before epoch",
    attributes: {},
    attributesSearch: {},
  },
  {
    id: id(9),
    timestamp: "1970-01-01T00:00:00.000000Z",
    level: "info",
    service: "epoch",
    message: "at epoch",
    attributes: {},
    attributesSearch: {},
  },
  {
    id: id(10),
    timestamp: "2026-03-29T00:59:59.999999Z",
    level: "info",
    service: "dst",
    message: "before European DST transition",
    attributes: {},
    attributesSearch: {},
  },
  {
    id: id(11),
    timestamp: "2026-03-29T01:00:00.000000Z",
    level: "info",
    service: "dst",
    message: "at European DST transition",
    attributes: {},
    attributesSearch: {},
  },
];

function databaseUrl(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function trustedDatabaseIdentifier(name: string): string {
  if (!/^logstream_aggregation_repository_test_[0-9]+$/u.test(name)) {
    throw new Error("Refusing an unexpected aggregation test database identifier.");
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

function parsed(input: Readonly<Record<string, unknown>>): ParsedLogAggregationQuery {
  const result = parseLogAggregationQuery(input);
  if (!result.ok) {
    throw new Error(`Expected a valid aggregation fixture: ${result.error.error}`);
  }
  return result.value;
}

function basicRequest(
  overrides: Readonly<Record<string, unknown>> = {},
): ParsedLogAggregationQuery {
  return parsed({
    since: "2026-08-09T10:00:00Z",
    until: "2026-08-09T12:00:00Z",
    bucket: "1m",
    ...overrides,
  });
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

describe.skipIf(!hasPostgresEnvironment)("log aggregation repository with PostgreSQL", () => {
  let runtimePool: Pool;
  let repository: LogAggregationRepository;

  beforeAll(async () => {
    if (adminBaseUrl === undefined || ownerBaseUrl === undefined || runtimeBaseUrl === undefined) {
      throw new Error("PostgreSQL integration URLs are unavailable.");
    }

    await withClient(adminBaseUrl, async (admin) => {
      await admin.query(
        `CREATE DATABASE ${trustedDatabaseIdentifier(databaseName)} OWNER logstream_owner TEMPLATE template0`,
      );
    });
    const ownerUrl = databaseUrl(ownerBaseUrl, databaseName);
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
    repository = createLogAggregationRepository(runtimePool);
  });

  afterAll(async () => {
    await runtimePool.end();
    if (adminBaseUrl !== undefined) {
      await withClient(adminBaseUrl, async (admin) => {
        await admin.query(`DROP DATABASE ${trustedDatabaseIdentifier(databaseName)} WITH (FORCE)`);
      });
    }
  });

  it("queries with the restricted role without privilege expansion", async () => {
    const evidence = await runtimePool.query<{
      current_user: string;
      can_select: boolean;
      can_delete: boolean;
      can_truncate: boolean;
      can_create_schema: boolean;
    }>(`
SELECT
  current_user,
  has_table_privilege(current_user, 'logstream.logs', 'SELECT') AS can_select,
  has_table_privilege(current_user, 'logstream.logs', 'DELETE') AS can_delete,
  has_table_privilege(current_user, 'logstream.logs', 'TRUNCATE') AS can_truncate,
  has_schema_privilege(current_user, 'logstream', 'CREATE') AS can_create_schema
`);

    expect(evidence.rows).toEqual([
      {
        current_user: "logstream_runtime",
        can_select: true,
        can_delete: false,
        can_truncate: false,
        can_create_schema: false,
      },
    ]);
    await expect(repository.aggregate(basicRequest())).resolves.not.toEqual([]);
  });

  it.each([
    {
      bucket: "1m",
      expected: [
        ["2026-08-09T10:00:00.000Z", 2],
        ["2026-08-09T10:01:00.000Z", 1],
        ["2026-08-09T10:04:00.000Z", 1],
        ["2026-08-09T10:05:00.000Z", 1],
        ["2026-08-09T11:00:00.000Z", 1],
      ],
    },
    {
      bucket: "5m",
      expected: [
        ["2026-08-09T10:00:00.000Z", 4],
        ["2026-08-09T10:05:00.000Z", 1],
        ["2026-08-09T11:00:00.000Z", 1],
      ],
    },
    {
      bucket: "1h",
      expected: [
        ["2026-08-09T10:00:00.000Z", 5],
        ["2026-08-09T11:00:00.000Z", 1],
      ],
    },
    { bucket: "1d", expected: [["2026-08-09T00:00:00.000Z", 6]] },
  ])("buckets existing rows with $bucket and omits empty buckets", async ({ bucket, expected }) => {
    const buckets = await repository.aggregate(basicRequest({ bucket }));

    expect(buckets.map((item) => [item.start, item.count])).toEqual(expected);
    expect(buckets.every((item) => item.group === null)).toBe(true);
  });

  it("preserves inclusive since, exclusive until, and equal-range behavior", async () => {
    await expect(
      repository.aggregate(
        parsed({
          since: "2026-08-09T10:00:00Z",
          until: "2026-08-09T10:01:00Z",
          bucket: "1m",
        }),
      ),
    ).resolves.toEqual([{ start: "2026-08-09T10:00:00.000Z", group: null, count: 2 }]);
    await expect(
      repository.aggregate(
        parsed({
          since: "2026-08-09T10:00:00Z",
          until: "2026-08-09T10:00:00Z",
          bucket: "1m",
        }),
      ),
    ).resolves.toEqual([]);
  });

  it.each([
    {
      group_by: "service",
      expected: [
        ["auth", 1],
        ["checkout", 3],
        ["worker", 1],
      ],
    },
    {
      group_by: "level",
      expected: [
        ["debug", 1],
        ["error", 2],
        ["info", 1],
        ["warn", 1],
      ],
    },
  ])("orders $group_by groups after bucket start", async ({ group_by, expected }) => {
    const buckets = await repository.aggregate(
      parsed({
        since: "2026-08-09T10:00:00Z",
        until: "2026-08-09T11:00:00Z",
        bucket: "1h",
        group_by,
      }),
    );

    expect(buckets.map((item) => [item.group, item.count])).toEqual(expected);
  });

  it("executes every shared filter together with literal search semantics", async () => {
    const buckets = await repository.aggregate(
      basicRequest({
        service: "checkout",
        level: "error",
        "attr.retries": "3",
        "attr.enabled": "true",
        q: "% _ \\",
        bucket: "1h",
        group_by: "service",
      }),
    );

    expect(buckets).toEqual([{ start: "2026-08-09T10:00:00.000Z", group: "checkout", count: 1 }]);
    await expect(repository.aggregate(basicRequest({ "attr.retries": "03" }))).resolves.toEqual([
      { start: "2026-08-09T10:01:00.000Z", group: null, count: 1 },
    ]);
  });

  it("keeps Unicode, backslashes, and prototype-sensitive attributes as data", async () => {
    const buckets = await repository.aggregate(
      basicRequest({
        "attr.__proto__": "prototype",
        "attr.constructor": "constructor",
        "attr.toString": "to-string",
        "attr.unicode-שלום": "ערך-世界",
        "attr.backslash-\\key": "value-\\path",
        bucket: "1h",
        group_by: "service",
      }),
    );

    expect(buckets).toEqual([{ start: "2026-08-09T10:00:00.000Z", group: "checkout", count: 1 }]);
    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();
  });

  it("keeps prototype-sensitive service groups as scalar values", async () => {
    const buckets = await repository.aggregate(
      basicRequest({ service: "__proto__", bucket: "1h", group_by: "service" }),
    );

    expect(buckets).toEqual([{ start: "2026-08-09T11:00:00.000Z", group: "__proto__", count: 1 }]);
    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();
  });

  it("aligns around the fixed UTC epoch", async () => {
    const buckets = await repository.aggregate(
      parsed({
        service: "epoch",
        since: "1969-12-31T23:59:00Z",
        until: "1970-01-01T00:01:00Z",
        bucket: "1m",
      }),
    );

    expect(buckets).toEqual([
      { start: "1969-12-31T23:59:00.000Z", group: null, count: 1 },
      { start: "1970-01-01T00:00:00.000Z", group: null, count: 1 },
    ]);
  });

  it("keeps UTC alignment across an offset and daylight-saving transition", async () => {
    const buckets = await repository.aggregate(
      parsed({
        service: "dst",
        since: "2026-03-29T01:00:00+01:00",
        until: "2026-03-29T04:00:00+02:00",
        bucket: "1h",
      }),
    );

    expect(buckets).toEqual([
      { start: "2026-03-29T00:00:00.000Z", group: null, count: 1 },
      { start: "2026-03-29T01:00:00.000Z", group: null, count: 1 },
    ]);
  });

  it("keeps injection-shaped filters as data and leaves the table intact", async () => {
    const injection = "checkout'); DROP TABLE logstream.logs; --";
    await expect(
      repository.aggregate(
        basicRequest({
          service: injection,
          'attr.key"} OR TRUE --': "value'); SELECT pg_sleep(10); --",
          q: "%' OR TRUE --",
        }),
      ),
    ).resolves.toEqual([]);

    const evidence = await runtimePool.query<{ table_name: string; count: number }>(`
SELECT
  to_regclass('logstream.logs')::text AS table_name,
  (SELECT COUNT(*)::integer FROM logstream.logs) AS count
`);
    expect(evidence.rows).toEqual([{ table_name: "logstream.logs", count: fixtures.length }]);
  });
});
