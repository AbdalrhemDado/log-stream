import type {
  AggregationResult,
  BenchmarkDiagnostics,
  BenchmarkTargetAssessment,
  FreshnessResult,
  IngestionPhaseResult,
  LoadGeneratorRunKind,
  RowReconciliation,
} from "./types.js";

function ingestionIsComplete(result: IngestionPhaseResult): boolean {
  const counters = result.counters;
  return (
    counters.requestsNotStarted === 0 &&
    counters.requestsUnresolved === 0 &&
    counters.transportFailures === 0 &&
    counters.timeouts === 0 &&
    counters.invalidResponses === 0 &&
    counters.serverRejectedRows === 0 &&
    counters.indeterminateRows === 0 &&
    counters.rowsNotAttempted === 0 &&
    counters.confirmedAcceptedRows === counters.rowsScheduled
  );
}

function aggregationIsComplete(result: AggregationResult): boolean {
  const counters = result.counters;
  return (
    counters.scheduledTicks > 0 &&
    counters.startedRequests === counters.scheduledTicks &&
    counters.completedRequests === counters.startedRequests &&
    counters.successfulResponses === counters.startedRequests &&
    counters.httpFailures === 0 &&
    counters.timeoutFailures === 0 &&
    counters.transportFailures === 0 &&
    counters.invalidResponses === 0 &&
    counters.missedTicks === 0 &&
    counters.unresolvedRequests === 0 &&
    !result.drainTimedOut
  );
}

function assessed(
  requirement: string,
  verified: boolean,
  evidence: string,
): BenchmarkTargetAssessment {
  return { requirement, status: verified ? "verified" : "not-verified", evidence };
}

export function assessBenchmarkTargets(input: {
  readonly runKind: LoadGeneratorRunKind;
  readonly configuredMeasuredRows: number;
  readonly warmup: IngestionPhaseResult;
  readonly measured: IngestionPhaseResult;
  readonly aggregation: AggregationResult;
  readonly freshness: FreshnessResult;
  readonly reconciliation: RowReconciliation;
  readonly diagnostics: BenchmarkDiagnostics;
  readonly resourceControlsVerified: boolean;
}): readonly BenchmarkTargetAssessment[] {
  const requirements = [
    "INF-003",
    "REL-001",
    "PERF-001",
    "PERF-002",
    "PERF-003",
    "PERF-004",
    "PERF-005",
    "PERF-006",
    "PERF-007",
  ] as const;
  if (input.runKind !== "baseline") {
    return requirements.map((requirement) => ({
      requirement,
      status: "not-evaluated",
      evidence: "This smoke run validates tooling and does not evaluate final performance targets.",
    }));
  }

  const warmupComplete = ingestionIsComplete(input.warmup);
  const measuredComplete = ingestionIsComplete(input.measured);
  const aggregationComplete = aggregationIsComplete(input.aggregation);
  const throughput = input.measured.confirmedAcceptedRowsPerSecond;
  const aggregationP95 = input.aggregation.requestLatencySuccessful.p95;
  const freshnessMs = input.freshness.postDispatchToVisibilityMs;
  const databaseRunRows = input.diagnostics.database["runRows"];
  const expectedRows = input.reconciliation.expectedRows;

  return [
    assessed(
      "INF-003",
      input.resourceControlsVerified,
      "Effective Docker HostConfig controls were inspected for 0.5 CPU/256 MiB app and 1 CPU/1 GiB PostgreSQL.",
    ),
    assessed(
      "REL-001",
      warmupComplete && measuredComplete && input.reconciliation.passed,
      `Warm-up complete=${String(warmupComplete)}; measured complete=${String(measuredComplete)}; reconciliation passed=${String(input.reconciliation.passed)}.`,
    ),
    assessed(
      "PERF-001",
      measuredComplete &&
        input.reconciliation.passed &&
        throughput !== null &&
        throughput >= 15_000,
      `Confirmed accepted throughput=${String(throughput)} logs/second; threshold=15000.`,
    ),
    assessed(
      "PERF-002",
      aggregationComplete && aggregationP95 !== null && aggregationP95 < 1_000,
      `Concurrent primary aggregation p95=${String(aggregationP95)} ms; threshold<1000 ms; complete=${String(aggregationComplete)}.`,
    ),
    assessed(
      "PERF-003",
      measuredComplete && aggregationComplete && aggregationP95 !== null && aggregationP95 < 1_000,
      `Ingestion and ${String(input.aggregation.counters.successfulResponses)} successful aggregation samples overlapped; p95=${String(aggregationP95)} ms.`,
    ),
    assessed(
      "PERF-004",
      input.configuredMeasuredRows === 1_000_000 &&
        input.reconciliation.passed &&
        databaseRunRows === expectedRows,
      `Configured measured rows=${String(input.configuredMeasuredRows)}; expected total=${String(expectedRows)}; PostgreSQL run rows=${String(databaseRunRows)}.`,
    ),
    assessed(
      "PERF-005",
      input.freshness.outcome === "visible" && freshnessMs !== null && freshnessMs <= 20_000,
      `Public-API dispatch-to-visibility=${String(freshnessMs)} ms; threshold<=20000 ms.`,
    ),
    assessed(
      "PERF-006",
      aggregationComplete,
      `Open-loop intended rate=1 request/second; scheduled=${String(input.aggregation.counters.scheduledTicks)}; started=${String(input.aggregation.counters.startedRequests)}; missed=${String(input.aggregation.counters.missedTicks)}.`,
    ),
    assessed(
      "PERF-007",
      input.diagnostics.queryPlans["recentUnfilteredPage"] !== undefined &&
        input.diagnostics.queryPlans["primaryAggregation"] !== undefined,
      "The report includes configuration, environment, raw latency samples, resources, reconciliation, and post-ingestion query plans.",
    ),
  ];
}
