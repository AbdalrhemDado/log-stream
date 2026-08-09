import { performance } from "node:perf_hooks";

import { normalizeAttributes } from "../../src/domain/attribute-normalizer.js";
import type { AttributeValue, NormalizedSearchAttributes } from "../../src/domain/attributes.js";
import { validateLogEntry } from "../../src/domain/log-entry-validator.js";
import type { LogId, ValidatedLogEntry } from "../../src/domain/log-entry.js";

const DEFAULT_SEED = 20_260_810;
const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_WARMUP_BATCHES = 2;
const DEFAULT_MEASURED_BATCHES = 10;
const DEFAULT_OUTPUT = "docs/performance/results/ingestion-microbenchmark-baseline.json";
const MAX_SEED = 4_294_967_295;
const MAX_BATCH_SIZE = 10_000;
const MAX_WARMUP_BATCHES = 20;
const MAX_MEASURED_BATCHES = 100;
const MAX_MEASURED_ROWS = 100_000;
const MAX_WARMUP_ROWS = 20_000;

const TASK_4_3_PATHS = new Set([
  "docs/performance/ingestion-microbenchmark.md",
  "docs/performance/results/ingestion-microbenchmark-baseline.json",
  "eslint.config.js",
  "package.json",
  "test/unit/ingestion-benchmark.test.ts",
  "tools/benchmark/ingestion-benchmark.ts",
  "tools/benchmark/run-ingestion-microbenchmark.ts",
  "tsconfig.json",
]);

const LEVELS = ["debug", "info", "warn", "error"] as const;
const SERVICES = ["checkout", "auth", "catalog", "payments"] as const;
const CHECKSUM_OFFSET_BASIS = 2_166_136_261;
const NORMALIZATION_VERIFICATION_MESSAGE = "Normalization benchmark verification failed.";

export class BenchmarkConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BenchmarkConfigurationError";
  }
}

export class BenchmarkVerificationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BenchmarkVerificationError";
  }
}

export interface BenchmarkOptions {
  readonly seed: number;
  readonly batchSize: number;
  readonly warmupBatches: number;
  readonly measuredBatches: number;
  readonly output: string;
}

export interface MemorySnapshot {
  readonly rssBytes: number;
  readonly heapTotalBytes: number;
  readonly heapUsedBytes: number;
  readonly externalBytes: number;
  readonly arrayBuffersBytes: number;
}

export interface SynchronousStageResult<Value> {
  readonly operationCount: number;
  readonly durationMs: number;
  readonly throughputPerSecond: number;
  readonly checksum: string;
  readonly values: readonly Value[];
}

export interface RepositorySummary {
  readonly batchCount: number;
  readonly batchSize: number;
  readonly operationCount: number;
  readonly samplesMs: readonly number[];
  readonly totalDurationMs: number;
  readonly throughputPerSecond: number;
  readonly batchLatencyP50Ms: number;
  readonly batchLatencyP95Ms: number;
  readonly batchLatencyP99Ms: number;
}

export interface BenchmarkReport {
  readonly schemaVersion: 1;
  readonly run: {
    readonly timestampUtc: string;
    readonly baseCommit: string;
    readonly branch: string;
    readonly workingTreeDirty: boolean;
    readonly task43PathsUncommitted: boolean;
    readonly sourceState: string;
  };
  readonly environment: {
    readonly nodeVersion: string;
    readonly npmVersion: string;
    readonly platform: string;
    readonly release: string;
    readonly architecture: string;
    readonly cpuModel: string;
    readonly logicalCpuCount: number;
    readonly hostMemoryBytes: number;
    readonly dockerVersion: string;
    readonly postgresImage: string;
    readonly postgresVersion: string;
  };
  readonly dockerControls: {
    readonly nanoCpus: number;
    readonly memoryBytes: number;
    readonly autoRemove: true;
    readonly persistentMountCount: 0;
  };
  readonly applicationProcess: {
    readonly constrainedToCompanyLimit: false;
    readonly note: string;
  };
  readonly configuration: {
    readonly seed: number;
    readonly batchSize: number;
    readonly warmupBatches: number;
    readonly measuredBatches: number;
    readonly warmupRows: number;
    readonly measuredRows: number;
    readonly poolMaximum: 4;
    readonly referenceTimeUtc: string;
  };
  readonly percentileMethod: string;
  readonly stages: {
    readonly validation: Omit<SynchronousStageResult<ValidatedLogEntry>, "values"> & {
      readonly memoryBefore: MemorySnapshot;
      readonly memoryAfter: MemorySnapshot;
    };
    readonly normalization: Omit<SynchronousStageResult<NormalizedSearchAttributes>, "values"> & {
      readonly memoryBefore: MemorySnapshot;
      readonly memoryAfter: MemorySnapshot;
    };
    readonly repository: RepositorySummary & {
      readonly expectedRows: number;
      readonly observedRows: number;
      readonly warmupResetObservedRows: 0;
      readonly immediateVisibilityQueryDurationMs: number;
      readonly memoryBefore: MemorySnapshot;
      readonly memoryAfter: MemorySnapshot;
    };
  };
  readonly limitations: readonly string[];
  readonly unverifiedRequirements: readonly string[];
}

export interface GitSourceState {
  readonly workingTreeDirty: boolean;
  readonly task43PathsUncommitted: boolean;
  readonly sourceState: string;
}

type NumericOptionName = "seed" | "batch-size" | "warmup-batches" | "measured-batches";

const NUMERIC_LIMITS: Readonly<Record<NumericOptionName, { minimum: number; maximum: number }>> = {
  seed: { minimum: 0, maximum: MAX_SEED },
  "batch-size": { minimum: 1, maximum: MAX_BATCH_SIZE },
  "warmup-batches": { minimum: 1, maximum: MAX_WARMUP_BATCHES },
  "measured-batches": { minimum: 1, maximum: MAX_MEASURED_BATCHES },
};

function parseNumericOption(name: NumericOptionName, value: string): number {
  const limits = NUMERIC_LIMITS[name];
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new BenchmarkConfigurationError(`--${name} must be an unsigned base-10 integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < limits.minimum || parsed > limits.maximum) {
    throw new BenchmarkConfigurationError(
      `--${name} must be between ${String(limits.minimum)} and ${String(limits.maximum)}.`,
    );
  }
  return parsed;
}

function readOptionValue(arguments_: readonly string[], index: number, flag: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new BenchmarkConfigurationError(`${flag} requires a value.`);
  }
  return value;
}

export function parseBenchmarkOptions(arguments_: readonly string[]): BenchmarkOptions {
  const values = new Map<string, string>();
  const supported = new Set([
    "--seed",
    "--batch-size",
    "--warmup-batches",
    "--measured-batches",
    "--output",
  ]);

  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    if (flag === undefined || !supported.has(flag)) {
      throw new BenchmarkConfigurationError("Unknown benchmark option.");
    }
    if (values.has(flag)) {
      throw new BenchmarkConfigurationError(`${flag} must not be repeated.`);
    }
    values.set(flag, readOptionValue(arguments_, index, flag));
  }

  const output = values.get("--output") ?? DEFAULT_OUTPUT;
  if (output.length === 0 || output.trim() !== output || !output.endsWith(".json")) {
    throw new BenchmarkConfigurationError("--output must be a non-empty, unpadded JSON path.");
  }

  const options: BenchmarkOptions = {
    seed: parseNumericOption("seed", values.get("--seed") ?? String(DEFAULT_SEED)),
    batchSize: parseNumericOption(
      "batch-size",
      values.get("--batch-size") ?? String(DEFAULT_BATCH_SIZE),
    ),
    warmupBatches: parseNumericOption(
      "warmup-batches",
      values.get("--warmup-batches") ?? String(DEFAULT_WARMUP_BATCHES),
    ),
    measuredBatches: parseNumericOption(
      "measured-batches",
      values.get("--measured-batches") ?? String(DEFAULT_MEASURED_BATCHES),
    ),
    output,
  };

  const measuredRows = options.batchSize * options.measuredBatches;
  const warmupRows = options.batchSize * options.warmupBatches;
  if (measuredRows > MAX_MEASURED_ROWS) {
    throw new BenchmarkConfigurationError("Measured repository rows must not exceed 100000.");
  }
  if (warmupRows > MAX_WARMUP_ROWS) {
    throw new BenchmarkConfigurationError("Warm-up repository rows must not exceed 20000.");
  }

  return options;
}

function porcelainPath(line: string): string | undefined {
  if (line.length < 4) {
    return undefined;
  }
  const path = line.slice(3);
  const renameSeparator = " -> ";
  const renameIndex = path.lastIndexOf(renameSeparator);
  return renameIndex === -1 ? path : path.slice(renameIndex + renameSeparator.length);
}

export function describeGitSourceState(statusOutput: string): GitSourceState {
  const paths = statusOutput
    .split(/\r?\n/u)
    .map(porcelainPath)
    .filter((path): path is string => path !== undefined && path.length > 0);
  const workingTreeDirty = paths.length > 0;
  const task43PathsUncommitted = paths.some((path) => TASK_4_3_PATHS.has(path));

  let sourceState = "Working tree is clean at the reported base commit.";
  if (task43PathsUncommitted) {
    sourceState = "Task 4.3 benchmark paths have uncommitted changes.";
  } else if (workingTreeDirty) {
    sourceState = "Working tree has uncommitted changes outside Task 4.3 benchmark paths.";
  }

  return { workingTreeDirty, task43PathsUncommitted, sourceState };
}

export async function closePreservingPrimaryError(
  close: () => Promise<void>,
  primaryError: Error | undefined,
  safeCleanupError: Error,
): Promise<Error | undefined> {
  try {
    await close();
  } catch {
    return primaryError ?? safeCleanupError;
  }
  return primaryError;
}

function createUint32Generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
}

export function createDeterministicLogId(seed: number, index: number): LogId {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new BenchmarkConfigurationError("UUID seed is outside the supported range.");
  }
  if (!Number.isSafeInteger(index) || index < 0 || index >= 1_000_000_000_000) {
    throw new BenchmarkConfigurationError("UUID index is outside the supported range.");
  }

  const seedHex = seed.toString(16).padStart(8, "0");
  const sequenceHex = (index + 1).toString(16).padStart(12, "0");
  return `${seedHex}-0000-4000-8000-${sequenceHex}` as LogId;
}

export function createDeterministicWorkload(
  count: number,
  seed: number,
  referenceTimeMs: number,
): readonly unknown[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_MEASURED_ROWS) {
    throw new BenchmarkConfigurationError("Workload count is outside the supported range.");
  }
  if (!Number.isSafeInteger(referenceTimeMs)) {
    throw new BenchmarkConfigurationError("Reference time must be a safe integer.");
  }
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new BenchmarkConfigurationError("Workload seed is outside the supported range.");
  }

  const nextUint32 = createUint32Generator(seed);
  const workload: unknown[] = [];
  for (let index = 0; index < count; index += 1) {
    const random = nextUint32();
    const level = LEVELS[random % LEVELS.length] ?? "info";
    const service = SERVICES[(random >>> 3) % SERVICES.length] ?? "checkout";
    const timestampOffsetMs = random % 3_600_000;
    workload.push({
      timestamp: new Date(referenceTimeMs - timestampOffsetMs).toISOString(),
      level,
      service,
      message: `benchmark event ${String(index)} for ${service}`,
      attributes: {
        request_id: `request-${seed.toString(16)}-${String(index)}`,
        retries: random % 8,
        enabled: (random & 1) === 0,
      },
    });
  }
  return workload;
}

function updateChecksum(checksum: number, value: string): number {
  let next = checksum;
  for (const character of value) {
    next ^= character.codePointAt(0) ?? 0;
    next = Math.imul(next, 16_777_619);
  }
  return next >>> 0;
}

function checksumToString(checksum: number): string {
  return checksum.toString(16).padStart(8, "0");
}

function normalizationVerificationFailure(): never {
  throw new BenchmarkVerificationError(NORMALIZATION_VERIFICATION_MESSAGE);
}

function expectedSearchValue(value: AttributeValue): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (!Number.isFinite(value)) {
    return normalizationVerificationFailure();
  }
  if (Object.is(value, -0)) {
    return "0";
  }
  return JSON.stringify(value);
}

export function verifyNormalizationResult(
  entries: readonly ValidatedLogEntry[],
  results: readonly NormalizedSearchAttributes[],
  measuredChecksum: string,
): void {
  if (entries.length !== results.length) {
    return normalizationVerificationFailure();
  }

  let expectedChecksum = CHECKSUM_OFFSET_BASIS;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const result = results[index];
    if (entry === undefined || result === undefined) {
      return normalizationVerificationFailure();
    }

    const expectedKeys = Object.keys(entry.attributes);
    const resultKeys = Object.keys(result);
    if (expectedKeys.length !== resultKeys.length) {
      return normalizationVerificationFailure();
    }

    for (const key of expectedKeys) {
      if (!Object.hasOwn(result, key)) {
        return normalizationVerificationFailure();
      }
      const originalValue = entry.attributes[key];
      if (originalValue === undefined) {
        return normalizationVerificationFailure();
      }
      const expectedValue = expectedSearchValue(originalValue);
      if (result[key] !== expectedValue) {
        return normalizationVerificationFailure();
      }
    }

    for (const key of resultKeys) {
      if (!Object.hasOwn(entry.attributes, key)) {
        return normalizationVerificationFailure();
      }
    }

    for (const key of expectedKeys.toSorted()) {
      const originalValue = entry.attributes[key];
      if (originalValue === undefined) {
        return normalizationVerificationFailure();
      }
      expectedChecksum = updateChecksum(expectedChecksum, key);
      expectedChecksum = updateChecksum(expectedChecksum, expectedSearchValue(originalValue));
    }
  }

  if (checksumToString(expectedChecksum) !== measuredChecksum) {
    return normalizationVerificationFailure();
  }
}

function calculateThroughput(operationCount: number, durationMs: number): number {
  if (!Number.isSafeInteger(operationCount) || operationCount < 1) {
    throw new BenchmarkVerificationError("Operation count must be a positive safe integer.");
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new BenchmarkVerificationError("Measured duration must be positive and finite.");
  }
  return operationCount / (durationMs / 1_000);
}

export function assertExpectedCount(stage: string, expected: number, observed: number): void {
  if (expected !== observed) {
    throw new BenchmarkVerificationError(
      `${stage} count mismatch: expected ${String(expected)}, observed ${String(observed)}.`,
    );
  }
}

export function measureValidation(
  inputs: readonly unknown[],
  referenceTimeMs: number,
  clock: () => number = () => performance.now(),
): SynchronousStageResult<ValidatedLogEntry> {
  const values: ValidatedLogEntry[] = [];
  let checksum = CHECKSUM_OFFSET_BASIS;
  const startedAt = clock();
  for (const input of inputs) {
    const result = validateLogEntry(input, referenceTimeMs);
    if (!result.ok) {
      throw new BenchmarkVerificationError(`Validation benchmark rejected input: ${result.reason}`);
    }
    values.push(result.value);
    checksum = updateChecksum(checksum, result.value.timestamp);
    checksum = updateChecksum(checksum, result.value.service);
    checksum = updateChecksum(checksum, result.value.message);
  }
  const durationMs = clock() - startedAt;
  assertExpectedCount("Validation", inputs.length, values.length);
  return {
    operationCount: values.length,
    durationMs,
    throughputPerSecond: calculateThroughput(values.length, durationMs),
    checksum: checksumToString(checksum),
    values,
  };
}

export function measureNormalization(
  entries: readonly ValidatedLogEntry[],
  clock: () => number = () => performance.now(),
): SynchronousStageResult<NormalizedSearchAttributes> {
  const values: NormalizedSearchAttributes[] = [];
  let checksum = CHECKSUM_OFFSET_BASIS;
  const startedAt = clock();
  for (const entry of entries) {
    const normalized = normalizeAttributes(entry.attributes);
    values.push(normalized);
    for (const key of Object.keys(normalized).toSorted()) {
      checksum = updateChecksum(checksum, key);
      checksum = updateChecksum(checksum, normalized[key] ?? "");
    }
  }
  const durationMs = clock() - startedAt;
  assertExpectedCount("Normalization", entries.length, values.length);
  return {
    operationCount: values.length,
    durationMs,
    throughputPerSecond: calculateThroughput(values.length, durationMs),
    checksum: checksumToString(checksum),
    values,
  };
}

export function nearestRank(samples: readonly number[], percentile: number): number {
  if (samples.length === 0) {
    throw new BenchmarkVerificationError("A percentile cannot be calculated from no samples.");
  }
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    throw new BenchmarkVerificationError("Percentile must be greater than 0 and at most 100.");
  }
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new BenchmarkVerificationError("Percentile samples must be finite and non-negative.");
  }

  const sorted = samples.toSorted((left, right) => left - right);
  const oneBasedRank = Math.ceil((percentile / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, oneBasedRank - 1));
  const value = sorted[index];
  if (value === undefined) {
    throw new BenchmarkVerificationError("Nearest-rank percentile selection failed.");
  }
  return value;
}

export function summarizeRepositorySamples(
  samplesMs: readonly number[],
  batchSize: number,
): RepositorySummary {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new BenchmarkVerificationError("Repository batch size must be positive.");
  }
  const totalDurationMs = samplesMs.reduce((total, sample) => total + sample, 0);
  const operationCount = samplesMs.length * batchSize;
  return {
    batchCount: samplesMs.length,
    batchSize,
    operationCount,
    samplesMs: [...samplesMs],
    totalDurationMs,
    throughputPerSecond: calculateThroughput(operationCount, totalDurationMs),
    batchLatencyP50Ms: nearestRank(samplesMs, 50),
    batchLatencyP95Ms: nearestRank(samplesMs, 95),
    batchLatencyP99Ms: nearestRank(samplesMs, 99),
  };
}

export function assertRowReconciliation(expectedRows: number, observedRows: number): void {
  assertExpectedCount("Repository row reconciliation", expectedRows, observedRows);
}

export function captureMemorySnapshot(
  readMemory: () => NodeJS.MemoryUsage = () => process.memoryUsage(),
): MemorySnapshot {
  const usage = readMemory();
  return {
    rssBytes: usage.rss,
    heapTotalBytes: usage.heapTotal,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  };
}

export function serializeBenchmarkReport(report: BenchmarkReport): string {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (/postgres(?:ql)?:\/\//iu.test(serialized)) {
    throw new BenchmarkVerificationError("Benchmark report contains a database URL.");
  }
  return serialized;
}
