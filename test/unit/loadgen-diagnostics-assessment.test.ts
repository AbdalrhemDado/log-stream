import { describe, expect, it } from "vitest";

import { assessBenchmarkTargets } from "../../tools/loadgen/assessment.js";
import {
  BASELINE_APPLICATION_ENVIRONMENT,
  captureBenchmarkDiagnostics,
} from "../../tools/loadgen/diagnostics.js";
import type {
  AggregationResult,
  BenchmarkDiagnostics,
  CommandInvocation,
  CommandResult,
  CommandRunner,
  FreshnessResult,
  IngestionPhaseResult,
  RowReconciliation,
} from "../../tools/loadgen/types.js";

const PROJECT = "logstream-loadgen-20260812120000-1-abcdef";
const CONTAINERS = { app: "a".repeat(64), postgres: "b".repeat(64) };
const RUN_ID = "lg-v1-0000002a-20260812t120000000z";
const REFERENCE = "2026-08-12T12:00:00.000Z";

function queueRunner(results: readonly CommandResult[], calls: CommandInvocation[]): CommandRunner {
  const queue = [...results];
  return (invocation) => {
    calls.push(invocation);
    const result = queue.shift();
    if (result === undefined) throw new Error("unexpected command");
    return Promise.resolve(result);
  };
}

function successfulPhase(phase: "warmup" | "measured", rows: number): IngestionPhaseResult {
  return {
    phase,
    counters: {
      requestsScheduled: 10,
      requestsStarted: 10,
      requestsCompleted: 10,
      requestsNotStarted: 0,
      requestsUnresolved: 0,
      statusCodes: { "200": 10 },
      transportFailures: 0,
      timeouts: 0,
      invalidResponses: 0,
      rowsScheduled: rows,
      attemptedRows: rows,
      rowsNotAttempted: 0,
      confirmedAcceptedRows: rows,
      serverRejectedRows: 0,
      indeterminateRows: 0,
    },
    durationMs: 1_000,
    confirmedAcceptedRowsPerSecond: 20_000,
    attemptedRowsPerSecond: 20_000,
    requestLatency: {
      unit: "milliseconds",
      method: "non-interpolated nearest-rank",
      sampleCount: 1,
      p50: 10,
      p95: 10,
      p99: 10,
      unavailableReason: null,
      rawSamples: [10],
      rawSamplesTruncated: false,
    },
    probe: null,
  };
}

const aggregation: AggregationResult = {
  counters: {
    scheduledTicks: 60,
    startedRequests: 60,
    completedRequests: 60,
    successfulResponses: 60,
    httpFailures: 0,
    timeoutFailures: 0,
    transportFailures: 0,
    invalidResponses: 0,
    missedTicks: 0,
    unresolvedRequests: 0,
  },
  intendedRatePerSecond: 1,
  achievedStartRatePerSecond: 1,
  requestLatencySuccessful: {
    unit: "milliseconds",
    method: "non-interpolated nearest-rank",
    sampleCount: 60,
    p50: 100,
    p95: 200,
    p99: 250,
    unavailableReason: null,
    rawSamples: [100, 200, 250],
    rawSamplesTruncated: false,
  },
  requestLatencyAllTerminal: {
    unit: "milliseconds",
    method: "non-interpolated nearest-rank",
    sampleCount: 60,
    p50: 100,
    p95: 200,
    p99: 250,
    unavailableReason: null,
    rawSamples: [100, 200, 250],
    rawSamplesTruncated: false,
  },
  schedulingLag: {
    unit: "milliseconds",
    method: "non-interpolated nearest-rank",
    sampleCount: 60,
    p50: 1,
    p95: 2,
    p99: 3,
    unavailableReason: null,
    rawSamples: [1, 2, 3],
    rawSamplesTruncated: false,
  },
  drainTimedOut: false,
};

const freshness: FreshnessResult = {
  outcome: "visible",
  postDispatchToVisibilityMs: 100,
  postAcknowledgementToVisibilityMs: 10,
  pollCount: 1,
  pollFailures: 0,
};

const reconciliation: RowReconciliation = {
  preExistingRows: 0,
  expectedRows: 1_010_000,
  observedRows: 1_010_000,
  delta: 0,
  passed: true,
};

const diagnostics: BenchmarkDiagnostics = {
  applicationEnvironment: BASELINE_APPLICATION_ENVIRONMENT,
  containerImages: { app: `sha256:${"a".repeat(64)}`, postgres: `sha256:${"b".repeat(64)}` },
  postgresSettings: { fsync: "on", synchronous_commit: "on" },
  database: { runRows: 1_010_000 },
  queryPlans: { recentUnfilteredPage: [], primaryAggregation: [] },
  planEvidenceBoundary: "post-ingestion",
};

describe("controlled benchmark diagnostics", () => {
  it("captures only allowlisted app configuration, fixed PostgreSQL evidence, and plans", async () => {
    const calls: CommandInvocation[] = [];
    const environment = [
      ...Object.entries(BASELINE_APPLICATION_ENVIRONMENT).map(
        ([name, value]) => `${name}=${value}`,
      ),
      "DATABASE_URL=postgresql://user:secret@postgres/logstream",
    ];
    const result = await captureBenchmarkDiagnostics({
      runner: queueRunner(
        [
          { exitCode: 0, stdout: `${JSON.stringify(environment)}\n`, stderr: "" },
          { exitCode: 0, stdout: `${JSON.stringify(`sha256:${"a".repeat(64)}`)}\n`, stderr: "" },
          { exitCode: 0, stdout: `${JSON.stringify(`sha256:${"b".repeat(64)}`)}\n`, stderr: "" },
          {
            exitCode: 0,
            stdout: '{"fsync":"on","synchronous_commit":"on"}\n',
            stderr: "",
          },
          {
            exitCode: 0,
            stdout:
              '{"runRows":1010000,"partitionCount":32,"databaseSizeBytes":1,"leafRelationTotalBytes":1,"leafTableBytes":1,"leafIndexBytes":1}\n',
            stderr: "",
          },
          { exitCode: 0, stdout: '[{"Plan":{"Node Type":"Limit"}}]\n', stderr: "" },
          { exitCode: 0, stdout: '[{"Plan":{"Node Type":"Sort"}}]\n', stderr: "" },
        ],
        calls,
      ),
      project: PROJECT,
      containers: CONTAINERS,
      runId: RUN_ID,
      referenceTimeUtc: REFERENCE,
    });

    expect(result.applicationEnvironment).toEqual(BASELINE_APPLICATION_ENVIRONMENT);
    expect(JSON.stringify(result)).not.toContain("DATABASE_URL");
    expect(result.database["runRows"]).toBe(1_010_000);
    expect(result.queryPlans).toHaveProperty("primaryAggregation");
    expect(calls.filter((call) => call.command === "docker")).toHaveLength(7);
    expect(calls.at(-1)?.stdin).toContain("EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS");
  });
});

describe("evidence-derived target assessment", () => {
  it("verifies every baseline target only when its measured predicate passes", () => {
    const result = assessBenchmarkTargets({
      runKind: "baseline",
      configuredMeasuredRows: 1_000_000,
      warmup: successfulPhase("warmup", 10_000),
      measured: successfulPhase("measured", 1_000_000),
      aggregation,
      freshness,
      reconciliation,
      diagnostics,
      resourceControlsVerified: true,
    });
    expect(result).toHaveLength(9);
    expect(result.filter((item) => item.status === "verified")).toHaveLength(8);
    expect(result.find((item) => item.requirement === "PERF-007")?.status).toBe("not-verified");
  });

  it("does not evaluate final targets for smoke runs", () => {
    const result = assessBenchmarkTargets({
      runKind: "smoke",
      configuredMeasuredRows: 1_000_000,
      warmup: successfulPhase("warmup", 10_000),
      measured: successfulPhase("measured", 1_000_000),
      aggregation,
      freshness,
      reconciliation,
      diagnostics,
      resourceControlsVerified: true,
    });
    expect(result.every((item) => item.status === "not-evaluated")).toBe(true);
  });

  it("does not verify throughput when measured acceptance is below target", () => {
    const measured = {
      ...successfulPhase("measured", 1_000_000),
      confirmedAcceptedRowsPerSecond: 14_999,
    };
    const result = assessBenchmarkTargets({
      runKind: "baseline",
      configuredMeasuredRows: 1_000_000,
      warmup: successfulPhase("warmup", 10_000),
      measured,
      aggregation,
      freshness,
      reconciliation,
      diagnostics,
      resourceControlsVerified: true,
    });
    expect(result.find((item) => item.requirement === "PERF-001")?.status).toBe("not-verified");
  });
});
