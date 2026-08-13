import { ratePerSecond, summarizeSamples } from "./statistics.js";
import type {
  IngestionCounters,
  IngestionPhaseResult,
  IngestionProbeObservation,
  IngestionRequestOutcome,
  MonotonicClock,
  ResolvedRunConfiguration,
  WorkloadBatch,
  WorkloadPhase,
} from "./types.js";
import { createWorkloadBatch } from "./workload.js";

export interface IngestionRequestResult {
  readonly outcome: IngestionRequestOutcome;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly latencyMs: number;
}

export type SendIngestionBatch = (
  batch: WorkloadBatch,
  signal?: AbortSignal,
) => Promise<IngestionRequestResult>;

interface MutableCounters {
  requestsScheduled: number;
  requestsStarted: number;
  requestsCompleted: number;
  statusCodes: Record<string, number>;
  transportFailures: number;
  timeouts: number;
  invalidResponses: number;
  rowsScheduled: number;
  attemptedRows: number;
  confirmedAcceptedRows: number;
  serverRejectedRows: number;
  indeterminateRows: number;
}

function isRejection(value: unknown): value is { readonly index: number; readonly reason: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isSafeInteger(Reflect.get(value, "index")) &&
    (Reflect.get(value, "index") as number) >= 0 &&
    typeof Reflect.get(value, "reason") === "string"
  );
}

export function validateIngestionResponse(
  status: number,
  body: unknown,
  attemptedRows: number,
): IngestionRequestOutcome {
  if (status !== 200 || typeof body !== "object" || body === null || Array.isArray(body)) {
    return { kind: "invalid-response", status };
  }
  const record = body as Record<string, unknown>;
  const accepted = record["accepted"];
  const rejected = record["rejected"];
  if (
    !Number.isSafeInteger(accepted) ||
    (accepted as number) < 0 ||
    !Array.isArray(rejected) ||
    !rejected.every(isRejection) ||
    (accepted as number) + rejected.length !== attemptedRows
  ) {
    return { kind: "invalid-response", status };
  }
  const indexes = new Set(rejected.map((item) => item.index));
  if (indexes.size !== rejected.length || [...indexes].some((index) => index >= attemptedRows)) {
    return { kind: "invalid-response", status };
  }
  return { kind: "success", status: 200, accepted: accepted as number, rejected };
}

export function assertIngestionAccounting(counters: IngestionCounters): void {
  if (counters.requestsScheduled !== counters.requestsStarted + counters.requestsNotStarted) {
    throw new Error("Ingestion request accounting invariant failed.");
  }
  if (counters.requestsStarted !== counters.requestsCompleted + counters.requestsUnresolved) {
    throw new Error("Ingestion started-request accounting invariant failed.");
  }
  if (
    counters.rowsScheduled !== counters.attemptedRows + counters.rowsNotAttempted ||
    counters.attemptedRows !==
      counters.confirmedAcceptedRows + counters.serverRejectedRows + counters.indeterminateRows
  ) {
    throw new Error("Ingestion row accounting invariant failed.");
  }
}

function immutableCounters(mutable: MutableCounters): IngestionCounters {
  const result: IngestionCounters = {
    ...mutable,
    requestsNotStarted: mutable.requestsScheduled - mutable.requestsStarted,
    requestsUnresolved: mutable.requestsStarted - mutable.requestsCompleted,
    rowsNotAttempted: mutable.rowsScheduled - mutable.attemptedRows,
    statusCodes: { ...mutable.statusCodes },
  };
  assertIngestionAccounting(result);
  return result;
}

function countStatus(counters: MutableCounters, status: number): void {
  const key = String(status);
  counters.statusCodes[key] = (counters.statusCodes[key] ?? 0) + 1;
}

export async function runIngestionPhase(input: {
  readonly configuration: ResolvedRunConfiguration;
  readonly phase: WorkloadPhase;
  readonly totalRows: number;
  readonly send: SendIngestionBatch;
  readonly clock: MonotonicClock;
  readonly signal?: AbortSignal;
  readonly onFirstDispatch?: (startedAtMs: number) => void;
  readonly onProbe?: (probe: IngestionProbeObservation) => void;
}): Promise<IngestionPhaseResult> {
  const batchCount = Math.ceil(input.totalRows / input.configuration.batchSize);
  const counters: MutableCounters = {
    requestsScheduled: batchCount,
    requestsStarted: 0,
    requestsCompleted: 0,
    statusCodes: {},
    transportFailures: 0,
    timeouts: 0,
    invalidResponses: 0,
    rowsScheduled: input.totalRows,
    attemptedRows: 0,
    confirmedAcceptedRows: 0,
    serverRejectedRows: 0,
    indeterminateRows: 0,
  };
  if (batchCount === 0) {
    return {
      phase: input.phase,
      counters: immutableCounters(counters),
      durationMs: null,
      confirmedAcceptedRowsPerSecond: null,
      attemptedRowsPerSecond: null,
      requestLatency: summarizeSamples([], "No ingestion requests were configured."),
      probe: null,
    };
  }

  const latencies: number[] = [];
  let nextBatchIndex = 0;
  let firstDispatchMs: number | undefined;
  let lastTerminalMs: number | undefined;
  let probe: IngestionProbeObservation | null = null;

  const worker = async (): Promise<void> => {
    while (nextBatchIndex < batchCount) {
      if (input.signal?.aborted === true) return;
      const batchIndex = nextBatchIndex;
      nextBatchIndex += 1;
      const batch = createWorkloadBatch({
        seed: input.configuration.seed,
        referenceTimeMs: input.configuration.referenceTimeMs,
        runId: input.configuration.runId,
        phase: input.phase,
        totalRows: input.totalRows,
        batchSize: input.configuration.batchSize,
        batchIndex,
      });
      counters.requestsStarted += 1;
      counters.attemptedRows += batch.logs.length;
      const dispatchMs = input.clock.now();
      if (firstDispatchMs === undefined) {
        firstDispatchMs = dispatchMs;
        input.onFirstDispatch?.(dispatchMs);
      }
      let result: IngestionRequestResult;
      try {
        result = await input.send(batch, input.signal);
      } catch {
        const completedAtMs = input.clock.now();
        result = {
          outcome: { kind: "transport" },
          startedAtMs: dispatchMs,
          completedAtMs,
          latencyMs: Math.max(0, completedAtMs - dispatchMs),
        };
      }
      counters.requestsCompleted += 1;
      lastTerminalMs = Math.max(lastTerminalMs ?? result.completedAtMs, result.completedAtMs);
      latencies.push(result.latencyMs);
      const rowCount = batch.logs.length;
      const outcome = result.outcome;
      if (outcome.kind === "success") {
        countStatus(counters, outcome.status);
        counters.confirmedAcceptedRows += outcome.accepted;
        counters.serverRejectedRows += outcome.rejected.length;
      } else if (outcome.kind === "http") {
        countStatus(counters, outcome.status);
        counters.indeterminateRows += rowCount;
      } else if (outcome.kind === "timeout") {
        counters.timeouts += 1;
        counters.indeterminateRows += rowCount;
      } else if (outcome.kind === "transport") {
        counters.transportFailures += 1;
        counters.indeterminateRows += rowCount;
      } else {
        countStatus(counters, outcome.status);
        counters.invalidResponses += 1;
        counters.indeterminateRows += rowCount;
      }

      if (batchIndex === 0 && input.phase === "measured") {
        const candidate = batch.logs[0];
        if (candidate !== undefined) {
          const accepted = outcome.kind === "success" && outcome.accepted === rowCount;
          probe = {
            log: candidate,
            postDispatchMonotonicMs: result.startedAtMs,
            postAcknowledgementMonotonicMs: accepted ? result.completedAtMs : null,
            accepted,
          };
          input.onProbe?.(probe);
        }
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(input.configuration.concurrency, batchCount) }, worker),
  );
  const durationMs =
    firstDispatchMs === undefined || lastTerminalMs === undefined
      ? null
      : Math.max(0, lastTerminalMs - firstDispatchMs);
  const immutable = immutableCounters(counters);
  return {
    phase: input.phase,
    counters: immutable,
    durationMs,
    confirmedAcceptedRowsPerSecond:
      durationMs === null ? null : ratePerSecond(immutable.confirmedAcceptedRows, durationMs),
    attemptedRowsPerSecond:
      durationMs === null ? null : ratePerSecond(immutable.attemptedRows, durationMs),
    requestLatency: summarizeSamples(latencies),
    probe,
  };
}
