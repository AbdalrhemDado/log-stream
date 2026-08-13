import { spawn } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "pg";

import type { DatabaseConfig } from "../../src/database/database-config.js";
import {
  createDatabasePool,
  createMigrationOwnerConnection,
  verifyRuntimeDatabase,
  type DatabasePool,
} from "../../src/database/database-pool.js";
import { loadMigrations } from "../../src/database/migrations/migration-loader.js";
import { runMigrationsWithOwnerRetry } from "../../src/database/migrations/migration-runner.js";
import { buildPartitionPlan } from "../../src/database/partitions/partition-plan.js";
import { preparePartitions } from "../../src/database/partitions/partition-preparer.js";
import { createLogAggregationRepository } from "../../src/modules/aggregation/log-aggregation-repository.js";
import { parseLogAggregationQuery } from "../../src/modules/aggregation/aggregation-parameter-parser.js";
import { buildLogPredicate } from "../../src/modules/query/log-predicate-builder.js";
import { createLogQueryRepository } from "../../src/modules/query/log-query-repository.js";
import {
  parseLogListQuery,
  type LogFilters,
} from "../../src/modules/query/query-parameter-parser.js";
import {
  assertAggregationReconciliation,
  assertDatasetBoundaryReconciliation,
  assertDatasetReconciliation,
  assertListReconciliation,
  calculateExpectedDatasetCounts,
  calculateExpectedDatasetBoundaries,
  closePreservingPrimaryError,
  createExplainCapture,
  createQueryScenarios,
  describeGitSourceState,
  parseQueryPlanOptions,
  QueryPlanConfigurationError,
  type QueryPlanOptions,
  type QueryPlanReport,
  QueryPlanVerificationError,
  serializeQueryPlanReport,
  type DatasetObservedCounts,
  type QueryScenario,
} from "./query-plan-review.js";

const POSTGRES_IMAGE = "postgres:16.14-bookworm";
const ADMIN_PASSWORD = "query_plan_admin_password";
const OWNER_PASSWORD = "query_plan_owner_password";
const RUNTIME_PASSWORD = "query_plan_runtime_password";
const DATABASE_NAME = "logstream_query_plan_review";
const POOL_MAXIMUM = 4 as const;
const RETENTION_DAYS = 30;
const QUERY_TIMEOUT_MS = 120_000;
const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));

const DATASET_INSERT_SQL = `
WITH generated AS (
  SELECT
    ordinal,
    ordinal::bigint + $1::bigint AS shifted,
    md5($1::text || ':' || ordinal::text) AS digest
  FROM generate_series(0, $2::integer - 1) AS ordinal
), prepared AS (
  SELECT
    $3::timestamptz
      - (((ordinal + 1)::double precision / $2::double precision) * INTERVAL '30 days')
        AS "timestamp",
    (
      substr(digest, 1, 8) || '-' ||
      substr(digest, 9, 4) || '-4' ||
      substr(digest, 14, 3) || '-8' ||
      substr(digest, 18, 3) || '-' ||
      substr(digest, 21, 12)
    )::uuid AS id,
    CASE mod(shifted, 4)
      WHEN 0 THEN 'debug'
      WHEN 1 THEN 'info'
      WHEN 2 THEN 'warn'
      ELSE 'error'
    END AS level,
    'service-' || lpad(mod(shifted, 100)::text, 3, '0') AS service,
    CASE
      WHEN mod(shifted, 1000) = 0 THEN 'Load Needle_%\\Path marker'
      ELSE 'ordinary message ' || ordinal::text
    END AS message,
    CASE
      WHEN mod(shifted, 10) = 0 THEN '{}'::jsonb
      ELSE jsonb_build_object(
        'region', 'region-' || lpad(mod(shifted, 8)::text, 2, '0'),
        'tenant_id', 'tenant-' || lpad(mod(shifted, 1000)::text, 6, '0'),
        'enabled', mod(shifted, 2) = 0,
        'retries', mod(shifted, 6)
      )
    END AS attributes,
    CASE
      WHEN mod(shifted, 10) = 0 THEN '{}'::jsonb
      ELSE jsonb_build_object(
        'region', 'region-' || lpad(mod(shifted, 8)::text, 2, '0'),
        'tenant_id', 'tenant-' || lpad(mod(shifted, 1000)::text, 6, '0'),
        'enabled', CASE WHEN mod(shifted, 2) = 0 THEN 'true' ELSE 'false' END,
        'retries', mod(shifted, 6)::text
      )
    END AS attributes_search
  FROM generated
)
INSERT INTO logstream.logs
  ("timestamp", id, level, service, message, attributes, attributes_search)
SELECT "timestamp", id, level, service, message, attributes, attributes_search
FROM prepared
`;

const DATASET_RECONCILIATION_SQL = `
SELECT
  COUNT(*)::text AS rows,
  COUNT(*) FILTER (WHERE attributes = '{}'::jsonb)::text AS empty_attributes,
  COUNT(*) FILTER (WHERE service = 'service-007')::text AS service_007,
  COUNT(*) FILTER (WHERE level = 'error')::text AS error_level,
  COUNT(*) FILTER (
    WHERE attributes_search @> '{"tenant_id":"tenant-000123"}'::jsonb
  )::text AS tenant_000123,
  COUNT(*) FILTER (WHERE message = 'Load Needle_%\\Path marker')::text AS message_marker,
  COUNT(*) FILTER (
    WHERE tableoid = 'logstream.logs_default'::regclass
  )::text AS default_partition_rows,
  to_char(
    MIN("timestamp") AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) AS minimum_timestamp,
  to_char(
    MAX("timestamp") AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) AS maximum_timestamp,
  COUNT(DISTINCT tableoid)::integer AS partition_count
FROM logstream.logs
`;

const POSTGRES_SETTING_NAMES = [
  "TimeZone",
  "shared_buffers",
  "work_mem",
  "effective_cache_size",
  "random_page_cost",
  "seq_page_cost",
  "max_parallel_workers_per_gather",
  "jit",
] as const;

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface DockerControls {
  readonly nanoCpus: 1_000_000_000;
  readonly memoryBytes: 1_073_741_824;
  readonly autoRemove: true;
  readonly persistentMountCount: 0;
}

interface DatabaseContext {
  readonly pool: DatabasePool;
  readonly ownerConnectionString: string;
  readonly postgresVersion: string;
}

export class QueryPlanExecutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "QueryPlanExecutionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateContainerName(name: string): void {
  if (!/^logstream-query-plan-[0-9]+-[a-z0-9]+$/u.test(name)) {
    throw new QueryPlanExecutionError("Refusing an unexpected query-plan container name.");
  }
}

function runCommand(command: string, arguments_: readonly string[]): Promise<CommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, arguments_, {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectCommand);
    child.on("close", (exitCode) => {
      resolveCommand({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

async function requireSuccessfulCommand(
  command: string,
  arguments_: readonly string[],
): Promise<CommandResult> {
  const result = await runCommand(command, arguments_);
  if (result.exitCode !== 0) {
    throw new QueryPlanExecutionError(`${command} command failed.`);
  }
  return result;
}

async function startPostgresContainer(containerName: string): Promise<void> {
  validateContainerName(containerName);
  await requireSuccessfulCommand("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--publish",
    "127.0.0.1::5432",
    "--cpus",
    "1.0",
    "--memory",
    "1g",
    "--tmpfs",
    "/var/lib/postgresql/data:rw",
    "--env",
    `POSTGRES_PASSWORD=${ADMIN_PASSWORD}`,
    "--env",
    "POSTGRES_DB=postgres",
    POSTGRES_IMAGE,
  ]);
}

async function inspectDockerControls(containerName: string): Promise<DockerControls> {
  const result = await requireSuccessfulCommand("docker", [
    "inspect",
    "--format",
    "{{json .}}",
    containerName,
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new QueryPlanExecutionError("Docker inspection returned invalid JSON.");
  }
  if (!isRecord(parsed) || !isRecord(parsed["HostConfig"]) || !Array.isArray(parsed["Mounts"])) {
    throw new QueryPlanExecutionError("Docker inspection omitted required controls.");
  }
  const hostConfig = parsed["HostConfig"];
  const nanoCpus = hostConfig["NanoCpus"];
  const memoryBytes = hostConfig["Memory"];
  const autoRemove = hostConfig["AutoRemove"];
  const persistentMounts = parsed["Mounts"].filter(
    (mount) => !isRecord(mount) || mount["Type"] !== "tmpfs",
  );
  if (
    nanoCpus !== 1_000_000_000 ||
    memoryBytes !== 1_073_741_824 ||
    autoRemove !== true ||
    persistentMounts.length !== 0
  ) {
    throw new QueryPlanExecutionError(
      "Effective Docker controls do not match the query-plan review.",
    );
  }
  return {
    nanoCpus: 1_000_000_000,
    memoryBytes: 1_073_741_824,
    autoRemove: true,
    persistentMountCount: 0,
  };
}

async function getPublishedPort(containerName: string): Promise<number> {
  const result = await requireSuccessfulCommand("docker", ["port", containerName, "5432/tcp"]);
  const match = /:(\d+)\s*$/u.exec(result.stdout.trim());
  const port = Number(match?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new QueryPlanExecutionError("Docker did not report a valid query-plan port.");
  }
  return port;
}

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      try {
        await client.end();
      } catch {
        // A new client is used for the next bounded readiness attempt.
      }
      await new Promise((resolveDelay) => {
        setTimeout(resolveDelay, 250);
      });
    }
  }
  throw new QueryPlanExecutionError("Disposable PostgreSQL did not become ready.");
}

async function bootstrapDatabase(adminConnectionString: string): Promise<void> {
  const client = new Client({ connectionString: adminConnectionString });
  let primaryError: Error | undefined;
  try {
    await client.connect();
    await client.query(`
CREATE ROLE logstream_owner
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  PASSWORD '${OWNER_PASSWORD}';
CREATE ROLE logstream_runtime
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  PASSWORD '${RUNTIME_PASSWORD}';
ALTER ROLE logstream_owner SET timezone TO 'UTC';
ALTER ROLE logstream_runtime SET timezone TO 'UTC';
`);
    await client.query(`CREATE DATABASE ${DATABASE_NAME} OWNER logstream_owner TEMPLATE template0`);
  } catch {
    primaryError = new QueryPlanExecutionError("Query-plan database bootstrap failed.");
  }
  primaryError = await closePreservingPrimaryError(
    () => client.end(),
    primaryError,
    new QueryPlanExecutionError("Query-plan bootstrap connection cleanup failed."),
  );
  if (primaryError !== undefined) {
    throw primaryError;
  }
}

function databaseUrl(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function createDatabaseContext(port: number, referenceTime: Date): Promise<DatabaseContext> {
  const adminBaseUrl = `postgresql://postgres:${ADMIN_PASSWORD}@127.0.0.1:${String(port)}/postgres`;
  await waitForPostgres(adminBaseUrl);
  await bootstrapDatabase(adminBaseUrl);
  const ownerConnectionString = databaseUrl(
    `postgresql://logstream_owner:${OWNER_PASSWORD}@127.0.0.1:${String(port)}/postgres`,
    DATABASE_NAME,
  );
  const runtimeConnectionString = databaseUrl(
    `postgresql://logstream_runtime:${RUNTIME_PASSWORD}@127.0.0.1:${String(port)}/postgres`,
    DATABASE_NAME,
  );
  const config: DatabaseConfig = {
    connectionString: runtimeConnectionString,
    migrationConnectionString: ownerConnectionString,
    maxConnections: POOL_MAXIMUM,
    connectionTimeoutMs: QUERY_TIMEOUT_MS,
    queryTimeoutMs: QUERY_TIMEOUT_MS,
    startupTimeoutMs: 60_000,
    retryDelayMs: 100,
    retentionDays: RETENTION_DAYS,
  };

  await runMigrationsWithOwnerRetry({
    createConnection: () => createMigrationOwnerConnection(config),
    loadMigrations: async () => loadMigrations(migrationsDirectory),
    timeoutMs: config.startupTimeoutMs,
    retryDelayMs: config.retryDelayMs,
    afterMigrations: async ({ database, deadline, retryDelayMs, clock }) => {
      await preparePartitions({
        database,
        partitions: buildPartitionPlan(referenceTime, config.retentionDays),
        deadline,
        retryDelayMs,
        clock,
      });
    },
  });

  const pool = createDatabasePool(config);
  try {
    await verifyRuntimeDatabase(pool);
    const versionResult = await pool.query<{ server_version: string }>("SHOW server_version");
    const postgresVersion = versionResult.rows[0]?.server_version;
    if (postgresVersion === undefined) {
      throw new QueryPlanExecutionError("PostgreSQL version inspection failed.");
    }
    return { pool, ownerConnectionString, postgresVersion };
  } catch (error: unknown) {
    try {
      await pool.end();
    } catch {
      // The safe primary setup error remains primary.
    }
    throw error;
  }
}

async function seedDatabase(
  ownerConnectionString: string,
  seed: number,
  rows: number,
  referenceTimeUtc: string,
): Promise<void> {
  const owner = new Client({ connectionString: ownerConnectionString });
  let primaryError: Error | undefined;
  try {
    await owner.connect();
    await owner.query(DATASET_INSERT_SQL, [seed, rows, referenceTimeUtc]);
    await owner.query("ANALYZE logstream.logs");
  } catch {
    primaryError = new QueryPlanExecutionError("Representative dataset setup failed.");
  }
  primaryError = await closePreservingPrimaryError(
    () => owner.end(),
    primaryError,
    new QueryPlanExecutionError("Dataset owner connection cleanup failed."),
  );
  if (primaryError !== undefined) {
    throw primaryError;
  }
}

function readCount(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new QueryPlanVerificationError("PostgreSQL returned an invalid reconciliation count.");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    throw new QueryPlanVerificationError("PostgreSQL returned an invalid reconciliation count.");
  }
  return count;
}

async function readDatasetEvidence(
  pool: DatabasePool,
  options: QueryPlanOptions,
  referenceTimeMs: number,
): Promise<DatasetObservedCounts> {
  const result = await pool.query(DATASET_RECONCILIATION_SQL);
  const row: unknown = result.rows[0];
  if (!isRecord(row) || result.rows.length !== 1) {
    throw new QueryPlanVerificationError("Dataset reconciliation failed.");
  }
  const minimumTimestamp = row["minimum_timestamp"];
  const maximumTimestamp = row["maximum_timestamp"];
  const partitionCount = row["partition_count"];
  if (
    typeof minimumTimestamp !== "string" ||
    typeof maximumTimestamp !== "string" ||
    typeof partitionCount !== "number" ||
    !Number.isSafeInteger(partitionCount)
  ) {
    throw new QueryPlanVerificationError("Dataset reconciliation failed.");
  }
  const observed: DatasetObservedCounts = {
    rows: readCount(row["rows"]),
    emptyAttributes: readCount(row["empty_attributes"]),
    service007: readCount(row["service_007"]),
    errorLevel: readCount(row["error_level"]),
    tenant000123: readCount(row["tenant_000123"]),
    messageMarker: readCount(row["message_marker"]),
    defaultPartitionRows: readCount(row["default_partition_rows"]),
    minimumTimestamp,
    maximumTimestamp,
    partitionCount,
  };
  assertDatasetReconciliation(calculateExpectedDatasetCounts(options.rows, options.seed), observed);
  assertDatasetBoundaryReconciliation(
    calculateExpectedDatasetBoundaries(options.rows, referenceTimeMs),
    observed,
  );
  return observed;
}

async function readPostgresSettings(pool: DatabasePool): Promise<Readonly<Record<string, string>>> {
  const result = await pool.query(
    "SELECT name, setting FROM pg_settings WHERE name = ANY($1::text[]) ORDER BY name",
    [[...POSTGRES_SETTING_NAMES]],
  );
  const settings: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const row of result.rows) {
    if (!isRecord(row) || typeof row["name"] !== "string" || typeof row["setting"] !== "string") {
      throw new QueryPlanVerificationError("PostgreSQL setting inspection failed.");
    }
    settings[row["name"]] = row["setting"];
  }
  if (
    Object.keys(settings).length !== POSTGRES_SETTING_NAMES.length ||
    settings["TimeZone"] !== "UTC"
  ) {
    throw new QueryPlanVerificationError("PostgreSQL setting inspection failed.");
  }
  return settings;
}

async function readDatabaseStructure(
  pool: DatabasePool,
): Promise<Readonly<Record<string, unknown>>> {
  const indexResult = await pool.query(`
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'logstream'
ORDER BY tablename, indexname
`);
  const indexes = indexResult.rows.map((row) => {
    if (
      !isRecord(row) ||
      typeof row["tablename"] !== "string" ||
      typeof row["indexname"] !== "string" ||
      typeof row["indexdef"] !== "string"
    ) {
      throw new QueryPlanVerificationError("Database index inspection failed.");
    }
    return {
      table: row["tablename"],
      name: row["indexname"],
      definition: row["indexdef"],
    };
  });
  const parentIndexNames = indexes
    .filter((index) => index.table === "logs")
    .map((index) => index.name)
    .sort();
  if (
    JSON.stringify(parentIndexNames) !==
    JSON.stringify(["logs_pkey", "logs_service_timestamp_id_idx"])
  ) {
    throw new QueryPlanVerificationError("The approved baseline index set has changed.");
  }

  const sizeResult = await pool.query(`
SELECT
  relation.relname AS name,
  relation.relkind::text AS kind,
  pg_relation_size(relation.oid)::text AS bytes
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'logstream'
  AND relation.relkind IN ('r', 'p', 'i', 'I')
ORDER BY relation.relkind, relation.relname
`);
  const relationSizes = sizeResult.rows.map((row) => {
    if (!isRecord(row) || typeof row["name"] !== "string" || typeof row["kind"] !== "string") {
      throw new QueryPlanVerificationError("Database size inspection failed.");
    }
    return { name: row["name"], kind: row["kind"], bytes: readCount(row["bytes"]) };
  });
  return { indexes, relationSizes };
}

async function countMatchingRows(pool: DatabasePool, filters: LogFilters): Promise<number> {
  const predicate = buildLogPredicate(filters);
  const result = await pool.query(
    `SELECT COUNT(*)::text AS count FROM logstream.logs AS logs WHERE ${predicate.text}`,
    [...predicate.values],
  );
  const row: unknown = result.rows[0];
  if (!isRecord(row) || result.rows.length !== 1) {
    throw new QueryPlanVerificationError("Query reconciliation failed.");
  }
  return readCount(row["count"]);
}

function checksum(value: unknown): string {
  const serialized = JSON.stringify(value);
  let hash = 2_166_136_261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function executeListScenario(
  pool: DatabasePool,
  scenario: QueryScenario,
): Promise<Readonly<Record<string, unknown>>> {
  const parsed = parseLogListQuery(scenario.query);
  if (!parsed.ok) {
    throw new QueryPlanVerificationError("A fixed list scenario is invalid.");
  }
  const capture = createExplainCapture(pool);
  await createLogQueryRepository(capture.database).findPage({
    filters: parsed.value.filters,
    limit: parsed.value.limit,
  });
  const captured = capture.readCapture();
  const result = await createLogQueryRepository(pool).findPage({
    filters: parsed.value.filters,
    limit: parsed.value.limit,
  });
  const matchingRows = await countMatchingRows(pool, parsed.value.filters);
  assertListReconciliation(
    matchingRows,
    result.length,
    captured.summary.rootActualRows,
    parsed.value.limit,
  );
  return {
    id: scenario.id,
    kind: scenario.kind,
    description: scenario.description,
    request: scenario.query,
    sql: captured.sql,
    parameters: captured.parameters,
    matchingRows,
    resultRows: result.length,
    resultChecksum: checksum(result),
    rawPlan: captured.document,
    summary: captured.summary,
  };
}

async function executeAggregationScenario(
  pool: DatabasePool,
  scenario: QueryScenario,
): Promise<Readonly<Record<string, unknown>>> {
  const parsed = parseLogAggregationQuery(scenario.query);
  if (!parsed.ok) {
    throw new QueryPlanVerificationError("The fixed aggregation scenario is invalid.");
  }
  const capture = createExplainCapture(pool);
  await createLogAggregationRepository(capture.database).aggregate(parsed.value);
  const captured = capture.readCapture();
  const result = await createLogAggregationRepository(pool).aggregate(parsed.value);
  const matchingRows = await countMatchingRows(pool, parsed.value.filters);
  const resultCountSum = result.reduce((sum, bucket) => sum + bucket.count, 0);
  assertAggregationReconciliation(
    matchingRows,
    result.length,
    resultCountSum,
    captured.summary.rootActualRows,
  );
  return {
    id: scenario.id,
    kind: scenario.kind,
    description: scenario.description,
    request: scenario.query,
    sql: captured.sql,
    parameters: captured.parameters,
    matchingRows,
    resultRows: result.length,
    resultCountSum,
    resultChecksum: checksum(result),
    rawPlan: captured.document,
    summary: captured.summary,
  };
}

async function readGitState(): Promise<QueryPlanReport["run"]> {
  const [commit, branch, status] = await Promise.all([
    requireSuccessfulCommand("git", ["rev-parse", "HEAD"]),
    requireSuccessfulCommand("git", ["branch", "--show-current"]),
    requireSuccessfulCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  return {
    timestampUtc: new Date().toISOString(),
    baseCommit: commit.stdout.trim(),
    branch: branch.stdout.trim(),
    ...describeGitSourceState(status.stdout),
  };
}

async function readNpmVersion(): Promise<string> {
  const npmExecutable = process.env["npm_execpath"];
  if (npmExecutable === undefined || npmExecutable.length === 0) {
    throw new QueryPlanExecutionError("The query-plan review must be started through npm.");
  }
  const result = await requireSuccessfulCommand(process.execPath, [npmExecutable, "--version"]);
  return result.stdout.trim();
}

async function executeReview(
  options: QueryPlanOptions,
  database: DatabaseContext,
  dockerControls: DockerControls,
  referenceTimeMs: number,
): Promise<QueryPlanReport> {
  const referenceTimeUtc = new Date(referenceTimeMs).toISOString();
  await seedDatabase(database.ownerConnectionString, options.seed, options.rows, referenceTimeUtc);
  const dataset = await readDatasetEvidence(database.pool, options, referenceTimeMs);
  const postgresSettings = await readPostgresSettings(database.pool);
  const structure = await readDatabaseStructure(database.pool);
  const queries: Readonly<Record<string, unknown>>[] = [];
  for (const scenario of createQueryScenarios(referenceTimeMs)) {
    queries.push(
      scenario.kind === "list"
        ? await executeListScenario(database.pool, scenario)
        : await executeAggregationScenario(database.pool, scenario),
    );
  }
  if (queries.length !== 6) {
    throw new QueryPlanVerificationError("The query-plan scenario set is incomplete.");
  }

  const [run, npmVersion, dockerVersion] = await Promise.all([
    readGitState(),
    readNpmVersion(),
    requireSuccessfulCommand("docker", ["version", "--format", "{{.Client.Version}}"]),
  ]);
  const cpuInfo = cpus();
  return {
    schemaVersion: 1,
    run,
    environment: {
      nodeVersion: process.version,
      npmVersion,
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      cpuModel: cpuInfo[0]?.model ?? "unknown",
      logicalCpuCount: cpuInfo.length,
      hostMemoryBytes: totalmem(),
      dockerVersion: dockerVersion.stdout.trim(),
      postgresImage: POSTGRES_IMAGE,
      postgresVersion: database.postgresVersion,
    },
    dockerControls,
    applicationProcess: {
      constrainedToCompanyLimit: false,
      note: "The TypeScript review process ran on the host; only disposable PostgreSQL used the 1 CPU/1 GiB controls.",
    },
    configuration: {
      seed: options.seed,
      rows: options.rows,
      referenceTimeUtc,
      datasetWindowDays: 30,
      poolMaximum: POOL_MAXIMUM,
      queryOrder: createQueryScenarios(referenceTimeMs).map((scenario) => scenario.id),
      generatorVersion: 1,
      generatorFormula:
        "Ordinals are evenly distributed across (reference-30d, reference); service=shifted mod 100, level=shifted mod 4, empty attributes=shifted mod 10, tenant=shifted mod 1000, marker=shifted mod 1000, shifted=ordinal+seed.",
      explainClause: "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, SETTINGS)",
      roleTimezoneDefaultApplied: true,
      plannerOrTuningSettingsChanged: false,
    },
    postgresSettings,
    database: { dataset, ...structure },
    queries,
    verifiedObservations: [
      "The disposable dataset and fixed query results reconciled with PostgreSQL counts.",
      "All production query values remained bound parameters.",
      "The runtime role executed every production SELECT and EXPLAIN.",
      "Only the accepted primary and service/time parent indexes were present.",
      "No planner or tuning setting was changed; established bootstrap set the owner and runtime role TimeZone default to UTC.",
    ],
    limitations: [
      "This is one controlled query-plan review, not a latency percentile benchmark.",
      "The dataset was inserted directly by the owner and bypassed HTTP and ingestion validation.",
      "Dataset reconciliation and fixed query order influence cache state; execution timings are descriptive only.",
      "No ingestion traffic or other concurrent workload was present.",
      "The representative primary aggregation scenario is a project review workload, not company-prescribed wording or a settled final load-test definition.",
      "The host TypeScript process did not run within the application 0.5 CPU and 256 MiB limits.",
      "No candidate level, JSONB, or trigram index was added or tested.",
    ],
    unverifiedRequirements: [
      "PERF-002 aggregation latency below one second at p95 during the required concurrent workload",
      "PERF-003 acceptable query performance while ingestion is active",
      "PERF-004 complete service capacity for the representative million-row month",
      "PERF-006 sustaining one aggregation request per second during ingestion",
      "PERF-007 final concurrent-load performance reporting",
      "INF-003 application and PostgreSQL resource-limit compliance for the complete service",
    ],
  };
}

async function cleanupContainer(containerName: string): Promise<void> {
  validateContainerName(containerName);
  const removal = await runCommand("docker", ["rm", "--force", containerName]);
  const alreadyAbsent = /No such (?:container|object)/iu.test(removal.stderr);
  if (removal.exitCode !== 0 && !alreadyAbsent) {
    throw new QueryPlanExecutionError("Disposable query-plan container cleanup failed.");
  }
  const verification = await runCommand("docker", ["inspect", containerName]);
  if (verification.exitCode === 0 || !/No such (?:container|object)/iu.test(verification.stderr)) {
    throw new QueryPlanExecutionError(
      "Disposable query-plan container still exists after cleanup.",
    );
  }
}

async function publishReportAtomically(output: string, report: QueryPlanReport): Promise<void> {
  const destination = resolve(output);
  const temporary = `${destination}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  try {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(temporary, serializeQueryPlanReport(report), { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

interface FinalizeReviewOptions<T> {
  readonly result: T | undefined;
  readonly primaryError: unknown;
  readonly closeRuntime?: () => Promise<void>;
  readonly cleanupContainer?: () => Promise<void>;
  readonly publish: (result: T) => Promise<void>;
}

function normalizeReviewError(error: unknown): Error {
  if (
    error instanceof QueryPlanConfigurationError ||
    error instanceof QueryPlanVerificationError ||
    error instanceof QueryPlanExecutionError
  ) {
    return error;
  }
  return new QueryPlanExecutionError("Query-plan review failed.");
}

export async function finalizeQueryPlanReview<T>(options: FinalizeReviewOptions<T>): Promise<T> {
  let primaryError = options.primaryError;
  if (options.closeRuntime !== undefined) {
    try {
      await options.closeRuntime();
    } catch {
      primaryError ??= new QueryPlanExecutionError("Query-plan runtime pool cleanup failed.");
    }
  }
  if (options.cleanupContainer !== undefined) {
    try {
      await options.cleanupContainer();
    } catch (error: unknown) {
      primaryError ??= error;
    }
  }
  if (primaryError !== undefined) {
    throw normalizeReviewError(primaryError);
  }
  if (options.result === undefined) {
    throw new QueryPlanExecutionError("Query-plan review completed without a report.");
  }
  await options.publish(options.result);
  return options.result;
}

export async function runQueryPlanReview(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const options = parseQueryPlanOptions(arguments_);
  const containerName = `logstream-query-plan-${String(process.pid)}-${Date.now().toString(36)}`;
  let containerStartupAttempted = false;
  let pool: DatabasePool | undefined;
  let report: QueryPlanReport | undefined;
  let primaryError: unknown;

  try {
    containerStartupAttempted = true;
    await startPostgresContainer(containerName);
    const dockerControls = await inspectDockerControls(containerName);
    const port = await getPublishedPort(containerName);
    const referenceTimeMs = Date.now();
    const database = await createDatabaseContext(port, new Date(referenceTimeMs));
    pool = database.pool;
    report = await executeReview(options, database, dockerControls, referenceTimeMs);
  } catch (error: unknown) {
    primaryError = error;
  }

  const publishedReport = await finalizeQueryPlanReview({
    result: report,
    primaryError,
    ...(pool === undefined ? {} : { closeRuntime: () => pool.end() }),
    ...(containerStartupAttempted
      ? { cleanupContainer: () => cleanupContainer(containerName) }
      : {}),
    publish: async (value) => publishReportAtomically(options.output, value),
  });
  process.stdout.write(
    `${JSON.stringify({
      output: options.output,
      rows: options.rows,
      plans: publishedReport.queries.length,
      cleanupVerified: true,
    })}\n`,
  );
}

export function isDirectEsmEntry(moduleUrl: string, executedPath: string | undefined): boolean {
  return executedPath !== undefined && pathToFileURL(resolve(executedPath)).href === moduleUrl;
}

if (isDirectEsmEntry(import.meta.url, process.argv[1])) {
  void runQueryPlanReview().catch((error: unknown) => {
    if (
      error instanceof QueryPlanConfigurationError ||
      error instanceof QueryPlanVerificationError ||
      error instanceof QueryPlanExecutionError
    ) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write("Query-plan review failed.\n");
    }
    process.exitCode = 1;
  });
}
