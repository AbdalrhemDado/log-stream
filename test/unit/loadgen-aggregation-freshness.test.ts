import { describe, expect, it, vi } from "vitest";

import {
  buildPrimaryAggregationUrl,
  startAggregationScheduler,
  validateAggregationBody,
  type AggregationRequestResult,
} from "../../tools/loadgen/aggregation.js";
import { buildFreshnessUrl, observeFreshness } from "../../tools/loadgen/freshness.js";
import type { IngestionProbeObservation, Sleep } from "../../tools/loadgen/types.js";
import { generateLog } from "../../tools/loadgen/workload.js";

interface PendingSleep {
  readonly target: number;
  readonly resolve: () => void;
}

function controlledTime(): {
  readonly clock: { now(): number };
  readonly sleep: Sleep;
  readonly advance: (target: number) => Promise<void>;
} {
  let now = 0;
  const pending: PendingSleep[] = [];
  return {
    clock: { now: () => now },
    sleep: (durationMs) =>
      durationMs === 0
        ? Promise.resolve()
        : new Promise((resolve) => pending.push({ target: now + durationMs, resolve })),
    advance: async (target) => {
      now = target;
      for (const sleeper of pending.splice(0).filter((item) => item.target <= target))
        sleeper.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function success(now: number): AggregationRequestResult {
  return { kind: "success", startedAtMs: now, completedAtMs: now + 5, latencyMs: 5 };
}

describe("open-loop aggregation workload", () => {
  it("builds the established 24-hour, 5m, service-grouped query", () => {
    const reference = Date.parse("2026-08-12T12:00:00.000Z");
    const url = buildPrimaryAggregationUrl("http://127.0.0.1:8080", reference);
    expect(url.pathname).toBe("/logs/aggregate");
    expect(url.searchParams.get("since")).toBe("2026-08-11T12:00:00.000Z");
    expect(url.searchParams.get("until")).toBe("2026-08-12T12:00:00.001Z");
    expect(url.searchParams.get("bucket")).toBe("5m");
    expect(url.searchParams.get("group_by")).toBe("service");
  });

  it("validates numeric aggregation counts without retaining response bodies", () => {
    expect(
      validateAggregationBody({
        buckets: [{ start: "2026-08-12T12:00:00.000Z", group: "checkout", count: 2 }],
      }),
    ).toBe(true);
    expect(
      validateAggregationBody({ buckets: [{ start: "invalid", group: null, count: 2 }] }),
    ).toBe(false);
    expect(
      validateAggregationBody({ buckets: [{ start: "2026-08-12T12:00:00Z", count: "2" }] }),
    ).toBe(false);
  });

  it("starts at absolute one-second deadlines and drains terminal requests", async () => {
    const time = controlledTime();
    const send = vi.fn(() => Promise.resolve(success(time.clock.now())));
    const scheduler = startAggregationScheduler({
      measuredStartMs: 0,
      clock: time.clock,
      sleep: time.sleep,
      send,
    });
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    await time.advance(1_000);
    expect(send).toHaveBeenCalledTimes(2);
    await time.advance(2_000);
    expect(send).toHaveBeenCalledTimes(3);
    const stopping = scheduler.stop(2_500);
    await time.advance(3_000);
    const result = await stopping;

    expect(result.counters).toMatchObject({
      scheduledTicks: 3,
      startedRequests: 3,
      completedRequests: 3,
      successfulResponses: 3,
      missedTicks: 0,
      unresolvedRequests: 0,
    });
    expect(result.achievedStartRatePerSecond).toBe(1.2);
    expect(result.requestLatencySuccessful.p95).toBe(5);
  });

  it("records lag and a missed tick when the overlap bound is full", async () => {
    const time = controlledTime();
    const send = vi.fn(
      (signal?: AbortSignal) =>
        new Promise<AggregationRequestResult>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              resolve({ kind: "timeout", startedAtMs: 0, completedAtMs: 3_000, latencyMs: 3_000 });
            },
            { once: true },
          );
        }),
    );
    const scheduler = startAggregationScheduler({
      measuredStartMs: 0,
      clock: time.clock,
      sleep: time.sleep,
      send,
      maximumInFlight: 1,
      drainTimeoutMs: 0,
      abortGraceMs: 0,
    });
    await Promise.resolve();
    await time.advance(1_100);
    expect(send).toHaveBeenCalledTimes(1);
    const stopping = scheduler.stop(1_500);
    await time.advance(2_000);
    const result = await stopping;
    expect(result.counters.missedTicks).toBe(1);
    expect(result.counters.timeoutFailures).toBe(1);
    expect(result.schedulingLag.rawSamples).toContain(100);
    expect(result.drainTimedOut).toBe(true);
  });

  it("accounts for elapsed deadlines as missed when stop races a delayed scheduler", async () => {
    const time = controlledTime();
    const send = vi.fn(() => Promise.resolve(success(time.clock.now())));
    const scheduler = startAggregationScheduler({
      measuredStartMs: 0,
      clock: time.clock,
      sleep: time.sleep,
      send,
    });
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);

    const stopping = scheduler.stop(2_500);
    await time.advance(3_000);
    const result = await stopping;

    expect(result.counters).toMatchObject({
      scheduledTicks: 3,
      startedRequests: 1,
      completedRequests: 1,
      missedTicks: 2,
      unresolvedRequests: 0,
    });
    expect(result.schedulingLag.rawSamples).toEqual([0, 1_500, 500]);
  });
});

describe("freshness observation", () => {
  const log = generateLog(
    42,
    Date.parse("2026-08-12T12:00:00.000Z"),
    "lg-v1-0000002a-20260812t120000000z",
    "measured",
    0,
  );
  const probe: IngestionProbeObservation = {
    log,
    postDispatchMonotonicMs: 0,
    postAcknowledgementMonotonicMs: 20,
    accepted: true,
  };

  it("constructs an exact public query from URLSearchParams", () => {
    const url = buildFreshnessUrl("http://127.0.0.1:8080", probe);
    expect(url.searchParams.get("attr.loadgen_run_id")).toBe(log.attributes.loadgen_run_id);
    expect(url.searchParams.get("attr.loadgen_phase")).toBe("measured");
    expect(url.searchParams.get("attr.loadgen_sequence")).toBe(log.attributes.loadgen_sequence);
    expect(url.searchParams.get("limit")).toBe("1");
  });

  it("records dispatch and acknowledgement visibility timing and poll failures", async () => {
    let now = 20;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }))
      .mockImplementationOnce(() => {
        now = 35;
        return Promise.resolve(
          new Response(
            JSON.stringify({ logs: [{ attributes: log.attributes }], next_cursor: null }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      });
    const result = await observeFreshness({
      baseUrl: "http://127.0.0.1:8080",
      probe,
      fetch: fetchMock,
      clock: { now: () => now },
      sleep: (durationMs) => {
        now += durationMs;
        return Promise.resolve();
      },
      requestTimeoutMs: 1_000,
      pollIntervalMs: 5,
      setTimeout: (() => 1) as unknown as typeof setTimeout,
      clearTimeout: vi.fn(),
    });
    expect(result).toEqual({
      outcome: "visible",
      postDispatchToVisibilityMs: 35,
      postAcknowledgementToVisibilityMs: 15,
      pollCount: 2,
      pollFailures: 1,
    });
  });

  it("does not poll when the deterministic probe was not confirmed accepted", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const result = await observeFreshness({
      baseUrl: "http://127.0.0.1:8080",
      probe: { ...probe, accepted: false },
      fetch: fetchMock,
      clock: { now: () => 0 },
      sleep: () => Promise.resolve(),
      requestTimeoutMs: 1_000,
    });
    expect(result.outcome).toBe("probe-not-accepted");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
