import { requireSuccessfulCommand, SafeCommandError } from "./commands.js";
import { assertValidComposeProjectName } from "./config.js";
import type { ComposeContainers } from "./docker.js";
import type { BenchmarkDiagnostics, CommandRunner } from "./types.js";

const RUN_ID_PATTERN = /^lg-v1-[a-f0-9]{8}-[0-9]{8}t[0-9]{9}z$/u;
const REFERENCE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const EXPECTED_APPLICATION_ENVIRONMENT = {
  DB_CONNECTION_TIMEOUT_MS: "2000",
  DB_POOL_MAX: "4",
  DB_RETRY_DELAY_MS: "500",
  DB_STARTUP_TIMEOUT_MS: "30000",
  LOG_LEVEL: "info",
  PORT: "8080",
  RETENTION_DAYS: "30",
} as const;

const POSTGRES_SETTINGS_SQL = String.raw`
SELECT json_object_agg(name, setting ORDER BY name)
FROM pg_settings
WHERE lower(name) IN (
  'effective_cache_size',
  'effective_io_concurrency',
  'fsync',
  'full_page_writes',
  'jit',
  'maintenance_work_mem',
  'max_connections',
  'random_page_cost',
  'server_version',
  'shared_buffers',
  'synchronous_commit',
  'timezone',
  'wal_level',
  'work_mem'
);
`;

const DATABASE_SUMMARY_SQL = String.raw`
WITH leaf_relations AS (
  SELECT relid
  FROM pg_partition_tree('logstream.logs'::regclass)
  WHERE isleaf
)
SELECT json_build_object(
  'runRows', (
    SELECT count(*)
    FROM logstream.logs
    WHERE attributes_search @> jsonb_build_object('loadgen_run_id', :'run_id')
  ),
  'partitionCount', (SELECT count(*) FROM leaf_relations),
  'databaseSizeBytes', pg_database_size(current_database()),
  'leafRelationTotalBytes', (
    SELECT coalesce(sum(pg_total_relation_size(relid)), 0) FROM leaf_relations
  ),
  'leafTableBytes', (
    SELECT coalesce(sum(pg_relation_size(relid)), 0) FROM leaf_relations
  ),
  'leafIndexBytes', (
    SELECT coalesce(sum(pg_indexes_size(relid)), 0) FROM leaf_relations
  )
);
`;

const RECENT_PAGE_PLAN_SQL = String.raw`
EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON)
SELECT
  logs.id,
  logs."timestamp",
  logs.level,
  logs.service,
  logs.message,
  logs.attributes
FROM logstream.logs AS logs
ORDER BY logs."timestamp" DESC, logs.id DESC
LIMIT 101;
`;

const PRIMARY_AGGREGATION_PLAN_SQL = String.raw`
EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON)
SELECT
  date_bin(
    INTERVAL '5 minutes',
    logs."timestamp",
    TIMESTAMPTZ '1970-01-01 00:00:00+00'
  ) AS bucket_start,
  logs.service,
  count(*)
FROM logstream.logs AS logs
WHERE logs."timestamp" >= (:'reference_time')::timestamptz - INTERVAL '24 hours'
  AND logs."timestamp" < (:'reference_time')::timestamptz + INTERVAL '1 millisecond'
GROUP BY 1, 2
ORDER BY 1 ASC, 2 ASC;
`;

function parseJsonObject(output: string, description: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new SafeCommandError(`${description} returned invalid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SafeCommandError(`${description} returned an invalid shape.`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function parseStringRecord(output: string, description: string): Readonly<Record<string, string>> {
  const parsed = parseJsonObject(output, description);
  if (Object.values(parsed).some((value) => typeof value !== "string")) {
    throw new SafeCommandError(`${description} contained a non-string value.`);
  }
  return parsed as Readonly<Record<string, string>>;
}

function parseNumberRecord(output: string, description: string): Readonly<Record<string, number>> {
  const parsed = parseJsonObject(output, description);
  if (
    Object.values(parsed).some((value) => !Number.isSafeInteger(value) || (value as number) < 0)
  ) {
    throw new SafeCommandError(`${description} contained an invalid numeric value.`);
  }
  return parsed as Readonly<Record<string, number>>;
}

function parsePlan(output: string, description: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new SafeCommandError(`${description} returned invalid JSON.`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new SafeCommandError(`${description} returned an invalid plan shape.`);
  }
  const first: unknown = (parsed as readonly unknown[])[0];
  if (typeof first !== "object" || first === null || !("Plan" in first)) {
    throw new SafeCommandError(`${description} omitted the plan tree.`);
  }
  return parsed;
}

async function inspectJson(
  runner: CommandRunner,
  containerId: string,
  format: string,
  failure: string,
): Promise<string> {
  const result = await requireSuccessfulCommand(
    runner,
    { command: "docker", args: ["inspect", "--format", format, containerId], timeoutMs: 10_000 },
    failure,
  );
  return result.stdout.trim();
}

async function captureApplicationEnvironment(
  runner: CommandRunner,
  appContainerId: string,
): Promise<Readonly<Record<string, string>>> {
  const output = await inspectJson(
    runner,
    appContainerId,
    "{{json .Config.Env}}",
    "Unable to inspect the application benchmark configuration.",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new SafeCommandError("Application benchmark configuration returned invalid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new SafeCommandError("Application benchmark configuration has an invalid shape.");
  }
  const environment = Object.create(null) as Record<string, string>;
  for (const name of Object.keys(EXPECTED_APPLICATION_ENVIRONMENT)) {
    const prefix = `${name}=`;
    const matching = parsed.filter((entry) => (entry as string).startsWith(prefix));
    if (matching.length !== 1) {
      throw new SafeCommandError("Application benchmark configuration is incomplete.");
    }
    environment[name] = (matching[0] as string).slice(prefix.length);
  }
  for (const [name, expected] of Object.entries(EXPECTED_APPLICATION_ENVIRONMENT)) {
    if (environment[name] !== expected) {
      throw new SafeCommandError("Application benchmark configuration differs from baseline.");
    }
  }
  return { ...environment };
}

async function captureContainerImages(
  runner: CommandRunner,
  containers: ComposeContainers,
): Promise<Readonly<Record<string, string>>> {
  const [app, postgres] = await Promise.all([
    inspectJson(runner, containers.app, "{{json .Image}}", "Unable to inspect the app image."),
    inspectJson(
      runner,
      containers.postgres,
      "{{json .Image}}",
      "Unable to inspect the PostgreSQL image.",
    ),
  ]);
  const parseImage = (value: string): string => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new SafeCommandError("Container image inspection returned invalid JSON.");
    }
    if (typeof parsed !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(parsed)) {
      throw new SafeCommandError("Container image inspection returned an invalid identity.");
    }
    return parsed;
  };
  return { app: parseImage(app), postgres: parseImage(postgres) };
}

async function runPsqlJson(input: {
  readonly runner: CommandRunner;
  readonly project: string;
  readonly sql: string;
  readonly variables?: readonly string[];
  readonly failure: string;
  readonly timeoutMs: number;
}): Promise<string> {
  const result = await requireSuccessfulCommand(
    input.runner,
    {
      command: "docker",
      args: [
        "compose",
        "-p",
        input.project,
        "exec",
        "--no-TTY",
        "--env",
        "PGOPTIONS=-c timezone=UTC",
        "postgres",
        "psql",
        "--username",
        "postgres",
        "--dbname",
        "logstream",
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--set",
        "ON_ERROR_STOP=1",
        ...(input.variables ?? []).flatMap((variable) => ["--set", variable]),
      ],
      timeoutMs: input.timeoutMs,
      stdin: input.sql,
    },
    input.failure,
  );
  return result.stdout;
}

export async function captureBenchmarkDiagnostics(input: {
  readonly runner: CommandRunner;
  readonly project: string;
  readonly containers: ComposeContainers;
  readonly runId: string;
  readonly referenceTimeUtc: string;
}): Promise<BenchmarkDiagnostics> {
  assertValidComposeProjectName(input.project);
  if (!RUN_ID_PATTERN.test(input.runId) || !REFERENCE_TIME_PATTERN.test(input.referenceTimeUtc)) {
    throw new SafeCommandError("Benchmark diagnostic marker or reference time is invalid.");
  }

  const [applicationEnvironment, containerImages, settingsOutput, databaseOutput] =
    await Promise.all([
      captureApplicationEnvironment(input.runner, input.containers.app),
      captureContainerImages(input.runner, input.containers),
      runPsqlJson({
        runner: input.runner,
        project: input.project,
        sql: POSTGRES_SETTINGS_SQL,
        failure: "Unable to capture PostgreSQL benchmark settings.",
        timeoutMs: 30_000,
      }),
      runPsqlJson({
        runner: input.runner,
        project: input.project,
        sql: DATABASE_SUMMARY_SQL,
        variables: [`run_id=${input.runId}`],
        failure: "Unable to capture the benchmark database summary.",
        timeoutMs: 60_000,
      }),
    ]);

  const planVariables = [`reference_time=${input.referenceTimeUtc}`] as const;
  const [recentPageOutput, primaryAggregationOutput] = await Promise.all([
    runPsqlJson({
      runner: input.runner,
      project: input.project,
      sql: RECENT_PAGE_PLAN_SQL,
      failure: "Unable to capture the recent-page query plan.",
      timeoutMs: 60_000,
    }),
    runPsqlJson({
      runner: input.runner,
      project: input.project,
      sql: PRIMARY_AGGREGATION_PLAN_SQL,
      variables: planVariables,
      failure: "Unable to capture the primary aggregation query plan.",
      timeoutMs: 120_000,
    }),
  ]);

  return {
    applicationEnvironment,
    containerImages,
    postgresSettings: parseStringRecord(settingsOutput, "PostgreSQL benchmark settings"),
    database: parseNumberRecord(databaseOutput, "Benchmark database summary"),
    queryPlans: {
      recentUnfilteredPage: parsePlan(recentPageOutput, "Recent-page query plan"),
      primaryAggregation: parsePlan(primaryAggregationOutput, "Primary aggregation query plan"),
    },
    planEvidenceBoundary:
      "Plans were captured after measured ingestion completed; concurrent aggregation latency comes from the public HTTP samples.",
  };
}

export const BASELINE_APPLICATION_ENVIRONMENT = EXPECTED_APPLICATION_ENVIRONMENT;
