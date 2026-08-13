import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import {
  LOAD_GENERATOR_VERSION,
  type LoadGeneratorOptions,
  type ResolvedRunConfiguration,
} from "./types.js";

const DEFAULTS = {
  measuredRows: 5_000,
  warmupRows: 500,
  batchSize: 100,
  concurrency: 4,
  seed: 20_260_812,
  outputPath: "docs/performance/results/load-generator-smoke.json",
  requestTimeoutMs: 5_000,
  baseUrl: "http://127.0.0.1:8080",
  runKind: "smoke",
} as const;

const MAX_REQUESTS = 250_000;
const NUMERIC_OPTIONS = {
  "--measured-rows": { key: "measuredRows", minimum: 1, maximum: 5_000_000 },
  "--warmup-rows": { key: "warmupRows", minimum: 0, maximum: 1_000_000 },
  "--batch-size": { key: "batchSize", minimum: 1, maximum: 50_000 },
  "--concurrency": { key: "concurrency", minimum: 1, maximum: 256 },
  "--seed": { key: "seed", minimum: 0, maximum: 4_294_967_295 },
  "--request-timeout-ms": { key: "requestTimeoutMs", minimum: 100, maximum: 120_000 },
} as const;

const STRING_OPTIONS = new Set(["--output", "--reference-time", "--base-url", "--run-kind"]);
const COMPOSE_PROJECT_PATTERN = /^logstream-loadgen-[a-z0-9-]{1,48}$/u;
const RUN_ID_PATTERN = /^lg-v1-[a-f0-9]{8}-[0-9]{8}t[0-9]{9}z$/u;

type NumericFlag = keyof typeof NUMERIC_OPTIONS;

export class LoadGeneratorConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LoadGeneratorConfigurationError";
  }
}

function readValue(arguments_: readonly string[], index: number, flag: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new LoadGeneratorConfigurationError(`${flag} requires a value.`);
  }
  return value;
}

function parseInteger(flag: NumericFlag, value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new LoadGeneratorConfigurationError(`${flag} must be an unsigned base-10 integer.`);
  }
  const parsed = Number(value);
  const limits = NUMERIC_OPTIONS[flag];
  if (!Number.isSafeInteger(parsed) || parsed < limits.minimum || parsed > limits.maximum) {
    throw new LoadGeneratorConfigurationError(
      `${flag} must be between ${String(limits.minimum)} and ${String(limits.maximum)}.`,
    );
  }
  return parsed;
}

function parseReferenceTime(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value);
  if (match === null) {
    throw new LoadGeneratorConfigurationError(
      "--reference-time must be a UTC ISO 8601 timestamp ending in Z.",
    );
  }
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp)) {
    throw new LoadGeneratorConfigurationError("--reference-time is outside the supported range.");
  }
  const canonical = new Date(timestamp).toISOString();
  const dateTime = match[1];
  if (dateTime === undefined) {
    throw new LoadGeneratorConfigurationError("--reference-time has an invalid date-time.");
  }
  const expectedCanonical = `${dateTime}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  if (canonical !== expectedCanonical) {
    throw new LoadGeneratorConfigurationError("--reference-time must identify a real instant.");
  }
  return canonical;
}

function parseBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LoadGeneratorConfigurationError("--base-url must be a valid URL.");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new LoadGeneratorConfigurationError("--base-url must not contain credentials.");
  }
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.port !== "8080" ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new LoadGeneratorConfigurationError(
      "Managed mode requires http://127.0.0.1:8080 or http://localhost:8080.",
    );
  }
  return parsed.toString().replace(/\/$/u, "");
}

function validateOutputPath(value: string): string {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    !value.toLowerCase().endsWith(".json") ||
    value.includes("\u0000")
  ) {
    throw new LoadGeneratorConfigurationError("--output must be an unpadded JSON file path.");
  }
  return resolve(value);
}

function parseRunKind(value: string): LoadGeneratorOptions["runKind"] {
  if (value !== "smoke" && value !== "baseline") {
    throw new LoadGeneratorConfigurationError("--run-kind must be smoke or baseline.");
  }
  return value;
}

export function parseLoadGeneratorOptions(arguments_: readonly string[]): LoadGeneratorOptions {
  const raw = new Map<string, string>();
  const supported = new Set([...Object.keys(NUMERIC_OPTIONS), ...STRING_OPTIONS]);

  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    if (flag === undefined || !supported.has(flag)) {
      throw new LoadGeneratorConfigurationError("Unknown load-generator option.");
    }
    if (raw.has(flag)) {
      throw new LoadGeneratorConfigurationError(`${flag} must not be repeated.`);
    }
    raw.set(flag, readValue(arguments_, index, flag));
  }

  const numericValues: Record<string, number> = {};
  for (const flag of Object.keys(NUMERIC_OPTIONS) as NumericFlag[]) {
    const definition = NUMERIC_OPTIONS[flag];
    const defaultValue = DEFAULTS[definition.key];
    numericValues[definition.key] = parseInteger(flag, raw.get(flag) ?? String(defaultValue));
  }

  const measuredRows = numericValues["measuredRows"] ?? DEFAULTS.measuredRows;
  const warmupRows = numericValues["warmupRows"] ?? DEFAULTS.warmupRows;
  const batchSize = numericValues["batchSize"] ?? DEFAULTS.batchSize;
  const requestCount = Math.ceil(measuredRows / batchSize) + Math.ceil(warmupRows / batchSize);
  if (requestCount > MAX_REQUESTS) {
    throw new LoadGeneratorConfigurationError(
      `Configuration schedules ${String(requestCount)} ingestion requests; the tool limit is ${String(MAX_REQUESTS)}.`,
    );
  }

  const reference = raw.get("--reference-time");
  return {
    measuredRows,
    warmupRows,
    batchSize,
    concurrency: numericValues["concurrency"] ?? DEFAULTS.concurrency,
    seed: numericValues["seed"] ?? DEFAULTS.seed,
    outputPath: validateOutputPath(raw.get("--output") ?? DEFAULTS.outputPath),
    requestTimeoutMs: numericValues["requestTimeoutMs"] ?? DEFAULTS.requestTimeoutMs,
    ...(reference === undefined ? {} : { referenceTimeUtc: parseReferenceTime(reference) }),
    baseUrl: parseBaseUrl(raw.get("--base-url") ?? DEFAULTS.baseUrl),
    runKind: parseRunKind(raw.get("--run-kind") ?? DEFAULTS.runKind),
  };
}

export function createRunId(seed: number, referenceTimeUtc: string): string {
  const seedHex = seed.toString(16).padStart(8, "0");
  const compactTime = referenceTimeUtc.replace(/[-:.]/gu, "").toLowerCase();
  const runId = `lg-v1-${seedHex}-${compactTime}`;
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new LoadGeneratorConfigurationError("Generated run marker is invalid.");
  }
  return runId;
}

export function createComposeProjectName(
  now: Date,
  processId: number,
  suffix = randomBytes(3).toString("hex"),
): string {
  const compact = now.toISOString().replace(/\D/gu, "").slice(0, 14).toLowerCase();
  const project = `logstream-loadgen-${compact}-${String(processId)}-${suffix.toLowerCase()}`;
  if (!COMPOSE_PROJECT_PATTERN.test(project)) {
    throw new LoadGeneratorConfigurationError("Generated Compose project name is invalid.");
  }
  return project;
}

export function assertValidComposeProjectName(project: string): void {
  if (!COMPOSE_PROJECT_PATTERN.test(project)) {
    throw new LoadGeneratorConfigurationError("Compose project name failed validation.");
  }
}

export function resolveRunConfiguration(
  options: LoadGeneratorOptions,
  dependencies: {
    readonly now?: () => Date;
    readonly processId?: number;
    readonly suffix?: string;
  } = {},
): ResolvedRunConfiguration {
  const now = dependencies.now?.() ?? new Date();
  const referenceTimeUtc = options.referenceTimeUtc ?? now.toISOString();
  const referenceTimeMs = Date.parse(referenceTimeUtc);
  const composeProject = createComposeProjectName(
    now,
    dependencies.processId ?? process.pid,
    dependencies.suffix,
  );
  const reproductionCommand = [
    "npm",
    "run",
    "loadgen",
    "--",
    "--measured-rows",
    String(options.measuredRows),
    "--warmup-rows",
    String(options.warmupRows),
    "--batch-size",
    String(options.batchSize),
    "--concurrency",
    String(options.concurrency),
    "--seed",
    String(options.seed),
    "--output",
    options.outputPath,
    "--request-timeout-ms",
    String(options.requestTimeoutMs),
    "--reference-time",
    referenceTimeUtc,
    "--base-url",
    options.baseUrl,
    "--run-kind",
    options.runKind,
  ] as const;

  return {
    ...options,
    referenceTimeUtc,
    referenceTimeMs,
    runId: createRunId(options.seed, referenceTimeUtc),
    composeProject,
    reproductionCommand,
  };
}

export const LOAD_GENERATOR_LIMITS = {
  maximumRequests: MAX_REQUESTS,
  generatorVersion: LOAD_GENERATOR_VERSION,
} as const;
