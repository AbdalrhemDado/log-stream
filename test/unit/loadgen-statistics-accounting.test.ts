import { describe, expect, it, vi } from "vitest";

import { parseLoadGeneratorOptions, resolveRunConfiguration } from "../../tools/loadgen/config.js";
import {
  assertIngestionAccounting,
  runIngestionPhase,
  validateIngestionResponse,
  type IngestionRequestResult,
} from "../../tools/loadgen/ingestion.js";
import { nearestRank, summarizeSamples } from "../../tools/loadgen/statistics.js";

const REFERENCE = "2026-08-12T12:34:56.789Z";
const configuration = resolveRunConfiguration(
  parseLoadGeneratorOptions([
    "--measured-rows",
    "5",
    "--warmup-rows",
    "4",
    "--batch-size",
    "2",
    "--concurrency",
    "1",
    "--reference-time",
    REFERENCE,
  ]),
  { now: () => new Date(REFERENCE), processId: 1, suffix: "abcdef" },
);

describe("nearest-rank load-generator statistics", () => {
  it("calculates non-interpolated p50, p95, and p99", () => {
    const samples = [10, 2, 4, 1, 8, 5, 3, 9, 6, 7];
    expect(nearestRank(samples, 50)).toBe(5);
    expect(nearestRank(samples, 95)).toBe(10);
    expect(nearestRank(samples, 99)).toBe(10);
    expect(summarizeSamples(samples)).toMatchObject({
      sampleCount: 10,
      p50: 5,
      p95: 10,
      p99: 10,
      unavailableReason: null,
      rawSamplesTruncated: false,
    });
  });

  it("represents an empty population as unavailable rather than zero", () => {
    expect(summarizeSamples([], "No samples.")).toEqual({
      unit: "milliseconds",
      method: "non-interpolated nearest-rank",
      sampleCount: 0,
      p50: null,
      p95: null,
      p99: null,
      unavailableReason: "No samples.",
      rawSamples: [],
      rawSamplesTruncated: false,
    });
  });
});

describe("ingestion accounting", () => {
  it("strictly validates accepted and rejected response identities", () => {
    expect(
      validateIngestionResponse(
        200,
        { accepted: 1, rejected: [{ index: 1, reason: "invalid" }] },
        2,
      ),
    ).toMatchObject({ kind: "success", accepted: 1 });
    expect(validateIngestionResponse(200, { accepted: 2, rejected: [] }, 1)).toMatchObject({
      kind: "invalid-response",
    });
    expect(
      validateIngestionResponse(
        200,
        {
          accepted: 0,
          rejected: [
            { index: 0, reason: "x" },
            { index: 0, reason: "y" },
          ],
        },
        2,
      ),
    ).toMatchObject({ kind: "invalid-response" });
  });

  it("accounts for HTTP, transport, timeout, invalid-response, and rejection outcomes without retry", async () => {
    let now = 0;
    const outcomes: IngestionRequestResult[] = [
      {
        outcome: {
          kind: "success",
          status: 200,
          accepted: 1,
          rejected: [{ index: 1, reason: "x" }],
        },
        startedAtMs: 0,
        completedAtMs: 10,
        latencyMs: 10,
      },
      {
        outcome: { kind: "http", status: 503 },
        startedAtMs: 10,
        completedAtMs: 20,
        latencyMs: 10,
      },
      {
        outcome: { kind: "timeout" },
        startedAtMs: 20,
        completedAtMs: 30,
        latencyMs: 10,
      },
      {
        outcome: { kind: "transport" },
        startedAtMs: 30,
        completedAtMs: 40,
        latencyMs: 10,
      },
      {
        outcome: { kind: "invalid-response", status: 200 },
        startedAtMs: 40,
        completedAtMs: 50,
        latencyMs: 10,
      },
    ];
    const send = vi.fn(() => {
      const result = outcomes.shift();
      if (result === undefined) throw new Error("unexpected retry");
      now = result.completedAtMs;
      return Promise.resolve(result);
    });
    const result = await runIngestionPhase({
      configuration,
      phase: "measured",
      totalRows: 10,
      send,
      clock: { now: () => now },
    });

    expect(send).toHaveBeenCalledTimes(5);
    expect(result.counters).toMatchObject({
      requestsScheduled: 5,
      requestsStarted: 5,
      requestsCompleted: 5,
      requestsNotStarted: 0,
      rowsScheduled: 10,
      attemptedRows: 10,
      rowsNotAttempted: 0,
      confirmedAcceptedRows: 1,
      serverRejectedRows: 1,
      indeterminateRows: 8,
      timeouts: 1,
      transportFailures: 1,
      invalidResponses: 1,
      statusCodes: { "200": 2, "503": 1 },
    });
    expect(() => {
      assertIngestionAccounting(result.counters);
    }).not.toThrow();
  });

  it("stops claiming new batches after abort and accounts for work not attempted", async () => {
    const controller = new AbortController();
    const send = vi.fn((batch: { readonly logs: readonly unknown[] }) => {
      controller.abort();
      return Promise.resolve({
        outcome: {
          kind: "success" as const,
          status: 200 as const,
          accepted: batch.logs.length,
          rejected: [],
        },
        startedAtMs: 0,
        completedAtMs: 5,
        latencyMs: 5,
      });
    });
    const result = await runIngestionPhase({
      configuration,
      phase: "measured",
      totalRows: 10,
      send,
      clock: { now: () => 0 },
      signal: controller.signal,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.counters).toMatchObject({
      requestsScheduled: 5,
      requestsStarted: 1,
      requestsCompleted: 1,
      requestsNotStarted: 4,
      rowsScheduled: 10,
      attemptedRows: 2,
      rowsNotAttempted: 8,
      confirmedAcceptedRows: 2,
      indeterminateRows: 0,
    });
  });

  it("keeps warm-up latency and acceptance separate from measured statistics", async () => {
    let now = 0;
    const sender = (latencyMs: number) => (batch: { readonly logs: readonly unknown[] }) => {
      const startedAtMs = now;
      now += latencyMs;
      return Promise.resolve({
        outcome: {
          kind: "success" as const,
          status: 200 as const,
          accepted: batch.logs.length,
          rejected: [],
        },
        startedAtMs,
        completedAtMs: now,
        latencyMs,
      });
    };
    const warmup = await runIngestionPhase({
      configuration,
      phase: "warmup",
      totalRows: 4,
      send: sender(100),
      clock: { now: () => now },
    });
    const measured = await runIngestionPhase({
      configuration,
      phase: "measured",
      totalRows: 5,
      send: sender(5),
      clock: { now: () => now },
    });
    expect(warmup.requestLatency.p50).toBe(100);
    expect(measured.requestLatency.p50).toBe(5);
    expect(measured.counters.confirmedAcceptedRows).toBe(5);
  });
});
