export const LOAD_GENERATOR_VERSION = "1.0.0";
export const REPORT_SCHEMA_VERSION = 2;

export type WorkloadPhase = "warmup" | "measured";
export type LoadGeneratorRunKind = "smoke" | "baseline";

export interface LoadGeneratorOptions {
  readonly measuredRows: number;
  readonly warmupRows: number;
  readonly batchSize: number;
  readonly concurrency: number;
  readonly seed: number;
  readonly outputPath: string;
  readonly requestTimeoutMs: number;
  readonly referenceTimeUtc?: string;
  readonly baseUrl: string;
  readonly runKind: LoadGeneratorRunKind;
}

export interface ResolvedRunConfiguration extends LoadGeneratorOptions {
  readonly referenceTimeUtc: string;
  readonly referenceTimeMs: number;
  readonly runId: string;
  readonly composeProject: string;
  readonly reproductionCommand: readonly string[];
}

export interface SyntheticAttributes {
  readonly loadgen_run_id: string;
  readonly loadgen_phase: WorkloadPhase;
  readonly loadgen_sequence: string;
  readonly request_id: string;
  readonly region: string;
  readonly attempt: number;
  readonly cached: boolean;
}

export interface SyntheticLog {
  readonly timestamp: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly service: string;
  readonly message: string;
  readonly attributes: SyntheticAttributes;
}

export interface WorkloadBatch {
  readonly phase: WorkloadPhase;
  readonly batchIndex: number;
  readonly firstOrdinal: number;
  readonly logs: readonly SyntheticLog[];
}

export type TerminalHttpOutcome =
  | { readonly kind: "success"; readonly status: number; readonly body: unknown }
  | { readonly kind: "http"; readonly status: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "transport" }
  | { readonly kind: "invalid-response"; readonly status: number };

export interface IngestionSuccess {
  readonly kind: "success";
  readonly status: 200;
  readonly accepted: number;
  readonly rejected: readonly { readonly index: number; readonly reason: string }[];
}

export type IngestionRequestOutcome =
  IngestionSuccess | Exclude<TerminalHttpOutcome, { readonly kind: "success" }>;

export interface PercentileSummary {
  readonly unit: "milliseconds";
  readonly method: "non-interpolated nearest-rank";
  readonly sampleCount: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly unavailableReason: string | null;
  readonly rawSamples: readonly number[];
  readonly rawSamplesTruncated: boolean;
}

export interface IngestionCounters {
  readonly requestsScheduled: number;
  readonly requestsStarted: number;
  readonly requestsCompleted: number;
  readonly requestsNotStarted: number;
  readonly requestsUnresolved: number;
  readonly statusCodes: Readonly<Record<string, number>>;
  readonly transportFailures: number;
  readonly timeouts: number;
  readonly invalidResponses: number;
  readonly rowsScheduled: number;
  readonly attemptedRows: number;
  readonly rowsNotAttempted: number;
  readonly confirmedAcceptedRows: number;
  readonly serverRejectedRows: number;
  readonly indeterminateRows: number;
}

export interface IngestionPhaseResult {
  readonly phase: WorkloadPhase;
  readonly counters: IngestionCounters;
  readonly durationMs: number | null;
  readonly confirmedAcceptedRowsPerSecond: number | null;
  readonly attemptedRowsPerSecond: number | null;
  readonly requestLatency: PercentileSummary;
  readonly probe: IngestionProbeObservation | null;
}

export interface IngestionProbeObservation {
  readonly log: SyntheticLog;
  readonly postDispatchMonotonicMs: number;
  readonly postAcknowledgementMonotonicMs: number | null;
  readonly accepted: boolean;
}

export interface AggregationCounters {
  readonly scheduledTicks: number;
  readonly startedRequests: number;
  readonly completedRequests: number;
  readonly successfulResponses: number;
  readonly httpFailures: number;
  readonly timeoutFailures: number;
  readonly transportFailures: number;
  readonly invalidResponses: number;
  readonly missedTicks: number;
  readonly unresolvedRequests: number;
}

export interface AggregationResult {
  readonly counters: AggregationCounters;
  readonly intendedRatePerSecond: 1;
  readonly achievedStartRatePerSecond: number | null;
  readonly requestLatencySuccessful: PercentileSummary;
  readonly requestLatencyAllTerminal: PercentileSummary;
  readonly schedulingLag: PercentileSummary;
  readonly drainTimedOut: boolean;
}

export interface FreshnessResult {
  readonly outcome: "visible" | "deadline-exceeded" | "probe-not-accepted" | "aborted";
  readonly postDispatchToVisibilityMs: number | null;
  readonly postAcknowledgementToVisibilityMs: number | null;
  readonly pollCount: number;
  readonly pollFailures: number;
}

export interface ContainerControls {
  readonly nanoCpus: number;
  readonly memoryBytes: number;
}

export interface ResourceSample {
  readonly elapsedMs: number;
  readonly appCpuPercent: number;
  readonly appMemoryBytes: number;
  readonly postgresCpuPercent: number;
  readonly postgresMemoryBytes: number;
}

export interface CleanupVerification {
  readonly attempted: boolean;
  readonly composeDownSucceeded: boolean;
  readonly remainingContainers: readonly string[];
  readonly remainingNetworks: readonly string[];
  readonly remainingVolumes: readonly string[];
  readonly passed: boolean;
  readonly error: string | null;
}

export interface RowReconciliation {
  readonly preExistingRows: number;
  readonly expectedRows: number;
  readonly observedRows: number;
  readonly delta: number;
  readonly passed: boolean;
}

export interface BenchmarkTargetAssessment {
  readonly requirement: string;
  readonly status: "verified" | "not-verified" | "not-evaluated";
  readonly evidence: string;
}

export interface BenchmarkDiagnostics {
  readonly applicationEnvironment: Readonly<Record<string, string>>;
  readonly containerImages: Readonly<Record<string, string>>;
  readonly postgresSettings: Readonly<Record<string, string>>;
  readonly database: Readonly<Record<string, number>>;
  readonly queryPlans: Readonly<Record<string, unknown>>;
  readonly planEvidenceBoundary: string;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly stdin?: string;
}

export type CommandRunner = (invocation: CommandInvocation) => Promise<CommandResult>;

export interface MonotonicClock {
  now(): number;
}

export type Sleep = (durationMs: number, signal?: AbortSignal) => Promise<void>;

export interface LoadGeneratorReport {
  readonly schemaVersion: 2;
  readonly outcome: "passed" | "failed";
  readonly failureReasons: readonly string[];
  readonly generatedAtUtc: string;
  readonly source: Readonly<Record<string, unknown>>;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly workload: Readonly<Record<string, unknown>>;
  readonly environment: Readonly<Record<string, unknown>>;
  readonly resourceControls: Readonly<Record<string, unknown>> | null;
  readonly resourceUsage: Readonly<Record<string, unknown>> | null;
  readonly warmup: IngestionPhaseResult | null;
  readonly aggregationWarmup: Readonly<Record<string, unknown>> | null;
  readonly measuredIngestion: IngestionPhaseResult | null;
  readonly aggregation: AggregationResult | null;
  readonly freshness: FreshnessResult | null;
  readonly reconciliation: RowReconciliation | null;
  readonly diagnostics: BenchmarkDiagnostics | null;
  readonly targetAssessment: readonly BenchmarkTargetAssessment[];
  readonly cleanup: CleanupVerification;
  readonly limitations: readonly string[];
  readonly unverifiedRequirements: readonly string[];
}
