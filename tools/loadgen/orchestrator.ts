import { performance } from "node:perf_hooks";

import { createAggregationSender, createIngestionSender } from "./api-client.js";
import { startAggregationScheduler } from "./aggregation.js";
import { assessBenchmarkTargets } from "./assessment.js";
import { createCommandRunner, SafeCommandError } from "./commands.js";
import { resolveRunConfiguration } from "./config.js";
import {
  assertPort8080Available,
  cleanupCompose,
  identifyComposeContainers,
  inspectAndVerifyControls,
  sampleDockerStats,
  startCompose,
  waitForHealth,
} from "./docker.js";
import { captureBenchmarkDiagnostics } from "./diagnostics.js";
import { captureEnvironment, captureGitSource } from "./environment.js";
import { observeFreshness } from "./freshness.js";
import { defaultSleep, systemClock, type HttpDependencies } from "./http.js";
import { runIngestionPhase } from "./ingestion.js";
import { countRunRows, reconcileRows } from "./reconciliation.js";
import { publishReportAtomically } from "./report.js";
import { ratePerSecond, summarizeSamples } from "./statistics.js";
import {
  LOAD_GENERATOR_VERSION,
  REPORT_SCHEMA_VERSION,
  type AggregationResult,
  type BenchmarkDiagnostics,
  type BenchmarkTargetAssessment,
  type CleanupVerification,
  type CommandRunner,
  type FreshnessResult,
  type IngestionPhaseResult,
  type LoadGeneratorOptions,
  type LoadGeneratorReport,
  type ResourceSample,
  type RowReconciliation,
  type Sleep,
} from "./types.js";
import { WORKLOAD_DISTRIBUTION } from "./workload.js";

const NO_CLEANUP: CleanupVerification = {
  attempted: false,
  composeDownSucceeded: false,
  remainingContainers: [],
  remainingNetworks: [],
  remainingVolumes: [],
  passed: false,
  error: "Cleanup has not run.",
};

export interface OrchestratorDependencies {
  readonly runner: CommandRunner;
  readonly fetch: typeof fetch;
  readonly sleep: Sleep;
  readonly now: () => Date;
  readonly clock: typeof systemClock;
  readonly setTimeout: typeof globalThis.setTimeout;
  readonly clearTimeout: typeof globalThis.clearTimeout;
  readonly publishReport: typeof publishReportAtomically;
}

function defaultDependencies(): OrchestratorDependencies {
  return {
    runner: createCommandRunner(),
    fetch,
    sleep: defaultSleep,
    now: () => new Date(),
    clock: systemClock,
    setTimeout,
    clearTimeout,
    publishReport: publishReportAtomically,
  };
}

function initialReport(now: Date, runKind: LoadGeneratorOptions["runKind"]): LoadGeneratorReport {
  const isSmoke = runKind === "smoke";
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    outcome: "failed",
    failureReasons: ["Run did not reach a verified terminal state."],
    generatedAtUtc: now.toISOString(),
    source: {},
    configuration: {},
    workload: {},
    environment: {},
    resourceControls: null,
    resourceUsage: null,
    warmup: null,
    aggregationWarmup: null,
    measuredIngestion: null,
    aggregation: null,
    freshness: null,
    reconciliation: null,
    diagnostics: null,
    targetAssessment: [],
    cleanup: NO_CLEANUP,
    limitations: [
      isSmoke
        ? "This bounded smoke validates the measurement tool, not final performance targets."
        : "This controlled baseline measures the frozen implementation without application tuning.",
      "Host scheduling, Docker Desktop virtualization, and the load client may affect observations.",
      "Resource sampling is periodic and may miss brief peaks.",
    ],
    unverifiedRequirements: [],
  };
}

function safeFailure(error: unknown): string {
  if (error instanceof SafeCommandError) return error.message;
  if (error instanceof Error && error.message.startsWith("Load-generator ")) return error.message;
  return "Load-generator execution failed without exposing internal details.";
}

function resourceSummary(samples: readonly ResourceSample[]): Readonly<Record<string, unknown>> {
  const maximum = (selector: (sample: ResourceSample) => number): number | null =>
    samples.length === 0 ? null : Math.max(...samples.map(selector));
  const intervals = samples
    .slice(1)
    .map((sample, index) => sample.elapsedMs - (samples[index]?.elapsedMs ?? sample.elapsedMs));
  const observationSpanMs =
    samples.length < 2 ? null : (samples.at(-1)?.elapsedMs ?? 0) - (samples[0]?.elapsedMs ?? 0);
  return {
    requestedDelayAfterSampleMs: 1_000,
    sampleCount: samples.length,
    observationSpanMs,
    achievedSampleStartsPerSecond:
      observationSpanMs === null ? null : ratePerSecond(samples.length - 1, observationSpanMs),
    sampleStartInterval: summarizeSamples(
      intervals,
      "At least two resource samples are required to calculate achieved cadence.",
    ),
    samples,
    maxima: {
      appCpuPercent: maximum((sample) => sample.appCpuPercent),
      appMemoryBytes: maximum((sample) => sample.appMemoryBytes),
      postgresCpuPercent: maximum((sample) => sample.postgresCpuPercent),
      postgresMemoryBytes: maximum((sample) => sample.postgresMemoryBytes),
    },
  };
}

function workloadFailures(input: {
  readonly warmup: IngestionPhaseResult;
  readonly measured: IngestionPhaseResult;
  readonly aggregation: AggregationResult;
  readonly freshness: FreshnessResult;
  readonly reconciliation: RowReconciliation;
}): string[] {
  const failures: string[] = [];
  for (const phase of [input.warmup, input.measured]) {
    if (
      phase.counters.transportFailures > 0 ||
      phase.counters.timeouts > 0 ||
      phase.counters.invalidResponses > 0 ||
      phase.counters.requestsNotStarted > 0 ||
      phase.counters.rowsNotAttempted > 0 ||
      phase.counters.serverRejectedRows > 0 ||
      phase.counters.indeterminateRows > 0 ||
      phase.counters.requestsUnresolved > 0
    ) {
      failures.push(`${phase.phase} ingestion contained non-success outcomes.`);
    }
  }
  if (
    input.aggregation.counters.successfulResponses < 1 ||
    input.aggregation.counters.httpFailures > 0 ||
    input.aggregation.counters.timeoutFailures > 0 ||
    input.aggregation.counters.transportFailures > 0 ||
    input.aggregation.counters.invalidResponses > 0 ||
    input.aggregation.counters.missedTicks > 0 ||
    input.aggregation.counters.unresolvedRequests > 0 ||
    input.aggregation.drainTimedOut
  ) {
    failures.push("Measured aggregation scheduling or request outcomes were incomplete.");
  }
  if (input.freshness.outcome !== "visible") {
    failures.push("The deterministic freshness probe was not observed within its deadline.");
  }
  if (!input.reconciliation.passed) {
    failures.push("PostgreSQL row reconciliation did not match confirmed HTTP acceptance.");
  }
  return failures;
}

export async function runManagedLoadGenerator(
  options: LoadGeneratorOptions,
  dependencyOverrides: Partial<OrchestratorDependencies> = {},
): Promise<LoadGeneratorReport> {
  const dependencies = { ...defaultDependencies(), ...dependencyOverrides };
  const configuration = resolveRunConfiguration(options, { now: dependencies.now });
  const httpDependencies: HttpDependencies = {
    fetch: dependencies.fetch,
    clock: dependencies.clock,
    setTimeout: dependencies.setTimeout,
    clearTimeout: dependencies.clearTimeout,
  };
  const abortController = new AbortController();
  const abort = (): void => {
    abortController.abort();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  let report = initialReport(dependencies.now(), configuration.runKind);
  let cleanup: CleanupVerification;
  let primaryFailure: string | null = null;
  let source: Readonly<Record<string, unknown>> = {};
  let environment: Readonly<Record<string, unknown>> = {};
  let resourceControls: Readonly<Record<string, unknown>> | null = null;
  let warmup: IngestionPhaseResult | null = null;
  let aggregationWarmup: Readonly<Record<string, unknown>> | null = null;
  let measured: IngestionPhaseResult | null = null;
  let aggregation: AggregationResult | null = null;
  let freshness: FreshnessResult | null = null;
  let reconciliation: RowReconciliation | null = null;
  let diagnostics: BenchmarkDiagnostics | null = null;
  let targetAssessment: readonly BenchmarkTargetAssessment[] = [];
  const resourceSamples: ResourceSample[] = [];

  try {
    source = await captureGitSource(dependencies.runner);
    await assertPort8080Available();
    await startCompose(dependencies.runner, configuration.composeProject);
    await waitForHealth({
      fetch: dependencies.fetch,
      sleep: dependencies.sleep,
      baseUrl: configuration.baseUrl,
      signal: abortController.signal,
    });
    const containers = await identifyComposeContainers(
      dependencies.runner,
      configuration.composeProject,
    );
    resourceControls = await inspectAndVerifyControls(dependencies.runner, containers);
    environment = await captureEnvironment(dependencies.runner, configuration.composeProject);
    const preExistingRows = await countRunRows(
      dependencies.runner,
      configuration.composeProject,
      configuration.runId,
    );
    if (preExistingRows !== 0) {
      throw new SafeCommandError(
        "The isolated database already contained the generated run marker.",
      );
    }

    const ingestionSender = createIngestionSender(
      { baseUrl: configuration.baseUrl, requestTimeoutMs: configuration.requestTimeoutMs },
      httpDependencies,
    );
    const aggregationSender = createAggregationSender(
      {
        baseUrl: configuration.baseUrl,
        referenceTimeMs: configuration.referenceTimeMs,
        requestTimeoutMs: configuration.requestTimeoutMs,
      },
      httpDependencies,
    );
    warmup = await runIngestionPhase({
      configuration,
      phase: "warmup",
      totalRows: configuration.warmupRows,
      send: ingestionSender,
      clock: dependencies.clock,
      signal: abortController.signal,
    });
    const aggregationWarmupResult = await aggregationSender(abortController.signal);
    aggregationWarmup = {
      attempted: true,
      successful: aggregationWarmupResult.kind === "success",
      terminalKind: aggregationWarmupResult.kind,
      latencyMs: aggregationWarmupResult.latencyMs,
    };
    if (aggregationWarmupResult.kind !== "success") {
      throw new SafeCommandError("The required aggregation warm-up request failed.");
    }

    const measuredStartMs = dependencies.clock.now();
    const scheduler = startAggregationScheduler({
      measuredStartMs,
      clock: dependencies.clock,
      sleep: dependencies.sleep,
      send: aggregationSender,
      signal: abortController.signal,
    });
    const samplingState = { active: true, failure: null as unknown };
    const activeContainers = containers;
    const sampler = (async (): Promise<void> => {
      try {
        while (samplingState.active && !abortController.signal.aborted) {
          resourceSamples.push(
            await sampleDockerStats(
              dependencies.runner,
              activeContainers,
              Math.max(0, dependencies.clock.now() - measuredStartMs),
            ),
          );
          await dependencies.sleep(1_000, abortController.signal);
        }
      } catch (error) {
        samplingState.failure = error;
      }
    })();
    const freshnessState: { promise: Promise<FreshnessResult> | null } = { promise: null };
    try {
      measured = await runIngestionPhase({
        configuration,
        phase: "measured",
        totalRows: configuration.measuredRows,
        send: ingestionSender,
        clock: dependencies.clock,
        signal: abortController.signal,
        onProbe: (probe) => {
          freshnessState.promise ??= observeFreshness({
            baseUrl: configuration.baseUrl,
            probe,
            fetch: dependencies.fetch,
            clock: dependencies.clock,
            sleep: dependencies.sleep,
            requestTimeoutMs: configuration.requestTimeoutMs,
            signal: abortController.signal,
          });
        },
      });
    } finally {
      const measuredEndMs = dependencies.clock.now();
      aggregation = await scheduler.stop(measuredEndMs);
      samplingState.active = false;
      await sampler;
    }
    if (samplingState.failure !== null) {
      throw new SafeCommandError("Docker resource sampling did not complete cleanly.");
    }
    const activeFreshness = freshnessState.promise;
    freshness =
      activeFreshness === null
        ? await observeFreshness({
            baseUrl: configuration.baseUrl,
            probe: measured.probe,
            fetch: dependencies.fetch,
            clock: dependencies.clock,
            sleep: dependencies.sleep,
            requestTimeoutMs: configuration.requestTimeoutMs,
            signal: abortController.signal,
          })
        : await activeFreshness;

    const observedRows = await countRunRows(
      dependencies.runner,
      configuration.composeProject,
      configuration.runId,
    );
    reconciliation = reconcileRows(
      preExistingRows,
      warmup.counters.confirmedAcceptedRows + measured.counters.confirmedAcceptedRows,
      observedRows,
    );
    diagnostics = await captureBenchmarkDiagnostics({
      runner: dependencies.runner,
      project: configuration.composeProject,
      containers,
      runId: configuration.runId,
      referenceTimeUtc: configuration.referenceTimeUtc,
    });
    targetAssessment = assessBenchmarkTargets({
      runKind: configuration.runKind,
      configuredMeasuredRows: configuration.measuredRows,
      warmup,
      measured,
      aggregation,
      freshness,
      reconciliation,
      diagnostics,
      resourceControlsVerified: true,
    });
    const failures = workloadFailures({ warmup, measured, aggregation, freshness, reconciliation });
    if (abortController.signal.aborted) failures.push("Run was interrupted by SIGINT or SIGTERM.");
    if (failures.length > 0) primaryFailure = failures.join(" ");
  } catch (error) {
    abortController.abort();
    primaryFailure = safeFailure(error);
  } finally {
    cleanup = await cleanupCompose(dependencies.runner, configuration.composeProject);
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }

  const failureReasons = [
    ...(primaryFailure === null ? [] : [primaryFailure]),
    ...(cleanup.passed ? [] : [cleanup.error ?? "Exact-project cleanup verification failed."]),
  ];
  report = {
    ...report,
    outcome: failureReasons.length === 0 ? "passed" : "failed",
    failureReasons,
    generatedAtUtc: dependencies.now().toISOString(),
    source,
    configuration: {
      measuredRows: configuration.measuredRows,
      warmupRows: configuration.warmupRows,
      batchSize: configuration.batchSize,
      concurrency: configuration.concurrency,
      outputPath: configuration.outputPath,
      requestTimeoutMs: configuration.requestTimeoutMs,
      baseUrl: configuration.baseUrl,
      reproductionCommand: configuration.reproductionCommand,
      composeProject: configuration.composeProject,
      runKind: configuration.runKind,
    },
    workload: {
      generatorVersion: LOAD_GENERATOR_VERSION,
      seed: configuration.seed,
      referenceTimeUtc: configuration.referenceTimeUtc,
      runId: configuration.runId,
      distribution: WORKLOAD_DISTRIBUTION,
      generationIdentity:
        "generator version + seed + reference timestamp + phase + global row ordinal",
    },
    environment,
    resourceControls,
    resourceUsage: resourceSummary(resourceSamples),
    warmup,
    aggregationWarmup,
    measuredIngestion: measured,
    aggregation,
    freshness,
    reconciliation,
    diagnostics,
    targetAssessment,
    cleanup,
    unverifiedRequirements: targetAssessment
      .filter((assessment) => assessment.status !== "verified")
      .map((assessment) => `${assessment.requirement}: ${assessment.status}`),
  };
  await dependencies.publishReport(configuration.outputPath, report);
  return report;
}

export function monotonicNow(): number {
  return performance.now();
}
