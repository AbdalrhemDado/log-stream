import { spawn } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
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
import type {
  LogInsertionRecord,
  NormalizedLogEntry,
  ValidatedLogEntry,
} from "../../src/domain/log-entry.js";
import { createIngestionRepository } from "../../src/modules/ingestion/ingestion-repository.js";
import {
  assertRowReconciliation,
  BenchmarkConfigurationError,
  type BenchmarkOptions,
  type BenchmarkReport,
  BenchmarkVerificationError,
  captureMemorySnapshot,
  closePreservingPrimaryError,
  createDeterministicLogId,
  createDeterministicWorkload,
  describeGitSourceState,
  measureNormalization,
  measureValidation,
  parseBenchmarkOptions,
  serializeBenchmarkReport,
  summarizeRepositorySamples,
  verifyNormalizationResult,
} from "./ingestion-benchmark.js";

const POSTGRES_IMAGE = "postgres:16.14-bookworm";
const ADMIN_PASSWORD = "benchmark_superuser_password";
const OWNER_PASSWORD = "benchmark_owner_password";
const RUNTIME_PASSWORD = "benchmark_runtime_password";
const DATABASE_NAME = "logstream_ingestion_benchmark";
const POOL_MAXIMUM = 4 as const;
const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
const containerName = `logstream-ingestion-benchmark-${String(process.pid)}-${Date.now().toString(36)}`;

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface DockerControls {
  readonly nanoCpus: number;
  readonly memoryBytes: number;
  readonly autoRemove: true;
  readonly persistentMountCount: 0;
}

interface DatabaseContext {
  readonly pool: DatabasePool;
  readonly ownerConnectionString: string;
  readonly postgresVersion: string;
}

class BenchmarkExecutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BenchmarkExecutionError";
  }
}

function validateContainerName(name: string): void {
  if (!/^logstream-ingestion-benchmark-[0-9]+-[a-z0-9]+$/u.test(name)) {
    throw new BenchmarkExecutionError("Refusing an unexpected benchmark container name.");
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
    throw new BenchmarkExecutionError(`${command} command failed.`);
  }
  return result;
}

async function startPostgresContainer(): Promise<void> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function inspectDockerControls(): Promise<DockerControls> {
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
    throw new BenchmarkExecutionError("Docker inspection returned invalid JSON.");
  }
  if (!isRecord(parsed) || !isRecord(parsed["HostConfig"]) || !Array.isArray(parsed["Mounts"])) {
    throw new BenchmarkExecutionError("Docker inspection omitted required controls.");
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
    throw new BenchmarkExecutionError("Effective Docker controls do not match the benchmark plan.");
  }

  return {
    nanoCpus,
    memoryBytes,
    autoRemove: true,
    persistentMountCount: 0,
  };
}

async function getPublishedPort(): Promise<number> {
  const result = await requireSuccessfulCommand("docker", ["port", containerName, "5432/tcp"]);
  const match = /:(\d+)\s*$/u.exec(result.stdout.trim());
  const port = Number(match?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new BenchmarkExecutionError("Docker did not report a valid benchmark port.");
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
        // A fresh client is used for the next bounded readiness attempt.
      }
      await new Promise((resolveDelay) => {
        setTimeout(resolveDelay, 250);
      });
    }
  }
  throw new BenchmarkExecutionError("Disposable PostgreSQL did not become ready.");
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
    primaryError = new BenchmarkExecutionError("Benchmark database bootstrap failed.");
  }

  primaryError = await closePreservingPrimaryError(
    () => client.end(),
    primaryError,
    new BenchmarkExecutionError("Benchmark bootstrap connection cleanup failed."),
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
    connectionTimeoutMs: 2_000,
    startupTimeoutMs: 30_000,
    retryDelayMs: 100,
    retentionDays: 1,
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
      throw new BenchmarkExecutionError("PostgreSQL version inspection failed.");
    }

    return { pool, ownerConnectionString, postgresVersion };
  } catch (error: unknown) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

function buildInsertionRecords(
  entries: readonly ValidatedLogEntry[],
  normalized: readonly NormalizedLogEntry["attributesSearch"][],
  seed: number,
  idOffset: number,
): readonly LogInsertionRecord[] {
  if (entries.length !== normalized.length) {
    throw new BenchmarkVerificationError("Insertion-record inputs have different lengths.");
  }
  return entries.map((entry, index) => ({
    ...entry,
    id: createDeterministicLogId(seed, idOffset + index),
    attributesSearch:
      normalized[index] ??
      (() => {
        throw new BenchmarkVerificationError("Normalized attributes are missing.");
      })(),
  }));
}

function splitBatches<T>(values: readonly T[], batchSize: number): readonly (readonly T[])[] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += batchSize) {
    batches.push(values.slice(index, index + batchSize));
  }
  return batches;
}

async function readRowCount(pool: DatabasePool): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "SELECT COUNT(*)::integer AS count FROM logstream.logs",
  );
  const count = result.rows[0]?.count;
  if (!Number.isSafeInteger(count) || count === undefined || count < 0) {
    throw new BenchmarkVerificationError("PostgreSQL returned an invalid row count.");
  }
  return count;
}

async function resetWarmupRows(ownerConnectionString: string): Promise<void> {
  const owner = new Client({ connectionString: ownerConnectionString });
  let primaryError: Error | undefined;
  try {
    await owner.connect();
    await owner.query("TRUNCATE TABLE logstream.logs");
  } catch {
    primaryError = new BenchmarkExecutionError("Owner-only benchmark reset failed.");
  }

  primaryError = await closePreservingPrimaryError(
    () => owner.end(),
    primaryError,
    new BenchmarkExecutionError("Benchmark owner connection cleanup failed."),
  );
  if (primaryError !== undefined) {
    throw primaryError;
  }
}

function synchronousReport(result: {
  readonly operationCount: number;
  readonly durationMs: number;
  readonly throughputPerSecond: number;
  readonly checksum: string;
  readonly values: readonly unknown[];
}) {
  return {
    operationCount: result.operationCount,
    durationMs: result.durationMs,
    throughputPerSecond: result.throughputPerSecond,
    checksum: result.checksum,
  };
}

async function readGitState(): Promise<BenchmarkReport["run"]> {
  const [commit, branch, status] = await Promise.all([
    requireSuccessfulCommand("git", ["rev-parse", "HEAD"]),
    requireSuccessfulCommand("git", ["branch", "--show-current"]),
    requireSuccessfulCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  const sourceState = describeGitSourceState(status.stdout);
  return {
    timestampUtc: new Date().toISOString(),
    baseCommit: commit.stdout.trim(),
    branch: branch.stdout.trim(),
    ...sourceState,
  };
}

async function readNpmVersion(): Promise<string> {
  const npmExecutable = process.env["npm_execpath"];
  if (npmExecutable === undefined || npmExecutable.length === 0) {
    throw new BenchmarkExecutionError("The benchmark must be started through npm.");
  }
  const result = await requireSuccessfulCommand(process.execPath, [npmExecutable, "--version"]);
  return result.stdout.trim();
}

async function executeBenchmark(
  options: BenchmarkOptions,
  database: DatabaseContext,
  dockerControls: DockerControls,
  referenceTimeMs: number,
): Promise<BenchmarkReport> {
  const warmupRows = options.batchSize * options.warmupBatches;
  const measuredRows = options.batchSize * options.measuredBatches;
  const warmupSeed = (options.seed ^ 0xa5a5a5a5) >>> 0;
  const repository = createIngestionRepository(database.pool);

  const warmupInputs = createDeterministicWorkload(warmupRows, warmupSeed, referenceTimeMs);
  const warmupValidation = measureValidation(warmupInputs, referenceTimeMs);
  const warmupNormalization = measureNormalization(warmupValidation.values);
  const warmupRecords = buildInsertionRecords(
    warmupValidation.values,
    warmupNormalization.values,
    options.seed,
    0,
  );
  for (const batch of splitBatches(warmupRecords, options.batchSize)) {
    await repository.insert(batch);
  }

  await resetWarmupRows(database.ownerConnectionString);
  const warmupResetObservedRows = await readRowCount(database.pool);
  assertRowReconciliation(0, warmupResetObservedRows);

  const measuredInputs = createDeterministicWorkload(measuredRows, options.seed, referenceTimeMs);
  const validationMemoryBefore = captureMemorySnapshot();
  const validation = measureValidation(measuredInputs, referenceTimeMs);
  const validationMemoryAfter = captureMemorySnapshot();

  const normalizationMemoryBefore = captureMemorySnapshot();
  const normalization = measureNormalization(validation.values);
  const normalizationMemoryAfter = captureMemorySnapshot();
  verifyNormalizationResult(validation.values, normalization.values, normalization.checksum);

  const records = buildInsertionRecords(
    validation.values,
    normalization.values,
    options.seed,
    warmupRows,
  );
  const repositoryMemoryBefore = captureMemorySnapshot();
  const repositorySamplesMs: number[] = [];
  for (const batch of splitBatches(records, options.batchSize)) {
    const startedAt = performance.now();
    await repository.insert(batch);
    repositorySamplesMs.push(performance.now() - startedAt);
  }
  const repositoryMemoryAfter = captureMemorySnapshot();
  const repositorySummary = summarizeRepositorySamples(repositorySamplesMs, options.batchSize);

  const visibilityStartedAt = performance.now();
  const observedRows = await readRowCount(database.pool);
  const immediateVisibilityQueryDurationMs = performance.now() - visibilityStartedAt;
  assertRowReconciliation(measuredRows, observedRows);

  const [run, npmVersion, dockerVersion] = await Promise.all([
    readGitState(),
    readNpmVersion(),
    requireSuccessfulCommand("docker", ["version", "--format", "{{.Client.Version}}"]),
  ]);
  const cpuInfo = cpus();
  const cpuModel = cpuInfo[0]?.model ?? "unknown";

  return {
    schemaVersion: 1,
    run,
    environment: {
      nodeVersion: process.version,
      npmVersion,
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      cpuModel,
      logicalCpuCount: cpuInfo.length,
      hostMemoryBytes: totalmem(),
      dockerVersion: dockerVersion.stdout.trim(),
      postgresImage: POSTGRES_IMAGE,
      postgresVersion: database.postgresVersion,
    },
    dockerControls,
    applicationProcess: {
      constrainedToCompanyLimit: false,
      note: "The benchmark TypeScript process ran on the host and was not constrained to 0.5 CPU or 256 MiB RAM.",
    },
    configuration: {
      seed: options.seed,
      batchSize: options.batchSize,
      warmupBatches: options.warmupBatches,
      measuredBatches: options.measuredBatches,
      warmupRows,
      measuredRows,
      poolMaximum: POOL_MAXIMUM,
      referenceTimeUtc: new Date(referenceTimeMs).toISOString(),
    },
    percentileMethod:
      "Non-interpolated nearest rank: sort ascending, rank=ceil(percentile/100*count), convert to a clamped zero-based index. With ten samples, p95 and p99 normally select the maximum and are descriptive only.",
    stages: {
      validation: {
        ...synchronousReport(validation),
        memoryBefore: validationMemoryBefore,
        memoryAfter: validationMemoryAfter,
      },
      normalization: {
        ...synchronousReport(normalization),
        memoryBefore: normalizationMemoryBefore,
        memoryAfter: normalizationMemoryAfter,
      },
      repository: {
        ...repositorySummary,
        expectedRows: measuredRows,
        observedRows,
        warmupResetObservedRows: 0,
        immediateVisibilityQueryDurationMs,
        memoryBefore: repositoryMemoryBefore,
        memoryAfter: repositoryMemoryAfter,
      },
    },
    limitations: [
      "This is a local functional microbenchmark, not an HTTP load test.",
      "The host application process did not run under the company application CPU and memory limits.",
      "Ten repository samples provide descriptive percentiles, not statistical confidence.",
      "No concurrent query or aggregation traffic was present.",
      "The measured dataset is much smaller than one million rows.",
      "Immediate row visibility is a functional observation, not final freshness-target evidence.",
      "One baseline does not justify changing UNNEST, pool size, indexes, or durability settings.",
    ],
    unverifiedRequirements: [
      "INF-003 application limit",
      "PERF-001",
      "PERF-002",
      "PERF-003",
      "PERF-004",
      "PERF-005",
      "PERF-006",
      "PERF-007 final reporting",
    ],
  };
}

async function cleanupContainer(): Promise<void> {
  validateContainerName(containerName);
  const removal = await runCommand("docker", ["rm", "--force", containerName]);
  const alreadyAbsent = /No such (?:container|object)/iu.test(removal.stderr);
  if (removal.exitCode !== 0 && !alreadyAbsent) {
    throw new BenchmarkExecutionError("Disposable benchmark container cleanup failed.");
  }

  const verification = await runCommand("docker", ["inspect", containerName]);
  if (verification.exitCode === 0 || !/No such (?:container|object)/iu.test(verification.stderr)) {
    throw new BenchmarkExecutionError("Disposable benchmark container still exists after cleanup.");
  }
}

async function publishReportAtomically(output: string, report: BenchmarkReport): Promise<void> {
  const destination = resolve(output);
  const temporary = `${destination}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  try {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(temporary, serializeBenchmarkReport(report), { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function runIngestionMicrobenchmark(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const options = parseBenchmarkOptions(arguments_);
  let containerStarted = false;
  let pool: DatabasePool | undefined;
  let report: BenchmarkReport | undefined;
  let primaryError: unknown;

  try {
    await startPostgresContainer();
    containerStarted = true;
    const dockerControls = await inspectDockerControls();
    const port = await getPublishedPort();
    const referenceTimeMs = Date.now();
    const referenceTime = new Date(referenceTimeMs);
    const database = await createDatabaseContext(port, referenceTime);
    pool = database.pool;
    report = await executeBenchmark(options, database, dockerControls, referenceTimeMs);
  } catch (error: unknown) {
    primaryError = error;
  }

  if (pool !== undefined) {
    try {
      await pool.end();
    } catch {
      primaryError ??= new BenchmarkExecutionError("Benchmark pool cleanup failed.");
    }
  }

  if (containerStarted) {
    try {
      await cleanupContainer();
    } catch (error: unknown) {
      primaryError ??= error;
    }
  }

  if (primaryError !== undefined) {
    if (
      primaryError instanceof BenchmarkConfigurationError ||
      primaryError instanceof BenchmarkVerificationError ||
      primaryError instanceof BenchmarkExecutionError
    ) {
      throw primaryError;
    }
    throw new BenchmarkExecutionError("Ingestion benchmark failed.");
  }
  if (report === undefined) {
    throw new BenchmarkExecutionError("Benchmark completed without a report.");
  }

  await publishReportAtomically(options.output, report);
  process.stdout.write(
    `${JSON.stringify({
      output: options.output,
      validationOperations: report.stages.validation.operationCount,
      normalizationOperations: report.stages.normalization.operationCount,
      repositoryRows: report.stages.repository.observedRows,
      repositoryBatches: report.stages.repository.batchCount,
      cleanupVerified: true,
    })}\n`,
  );
}

export function isDirectEsmEntry(moduleUrl: string, executedPath: string | undefined): boolean {
  return executedPath !== undefined && pathToFileURL(resolve(executedPath)).href === moduleUrl;
}

if (isDirectEsmEntry(import.meta.url, process.argv[1])) {
  void runIngestionMicrobenchmark().catch((error: unknown) => {
    if (
      error instanceof BenchmarkConfigurationError ||
      error instanceof BenchmarkVerificationError ||
      error instanceof BenchmarkExecutionError
    ) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write("Ingestion benchmark failed.\n");
    }
    process.exitCode = 1;
  });
}
