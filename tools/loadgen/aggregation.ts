import { ratePerSecond, summarizeSamples } from "./statistics.js";
import type { AggregationCounters, AggregationResult, MonotonicClock, Sleep } from "./types.js";

export interface AggregationRequestResult {
  readonly kind: "success" | "http" | "timeout" | "transport" | "invalid-response";
  readonly status?: number;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly latencyMs: number;
}

export type SendAggregationRequest = (signal?: AbortSignal) => Promise<AggregationRequestResult>;

interface MutableAggregationCounters {
  scheduledTicks: number;
  startedRequests: number;
  completedRequests: number;
  successfulResponses: number;
  httpFailures: number;
  timeoutFailures: number;
  transportFailures: number;
  invalidResponses: number;
  missedTicks: number;
}

export function buildPrimaryAggregationUrl(baseUrl: string, referenceTimeMs: number): URL {
  const url = new URL("/logs/aggregate", `${baseUrl}/`);
  url.searchParams.set("since", new Date(referenceTimeMs - 24 * 60 * 60 * 1_000).toISOString());
  url.searchParams.set("until", new Date(referenceTimeMs + 1).toISOString());
  url.searchParams.set("bucket", "5m");
  url.searchParams.set("group_by", "service");
  return url;
}

export function validateAggregationBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const bodyRecord = body as Record<string, unknown>;
  if (!Array.isArray(bodyRecord["buckets"])) return false;
  return bodyRecord["buckets"].every((bucket) => {
    if (typeof bucket !== "object" || bucket === null || Array.isArray(bucket)) return false;
    const bucketRecord = bucket as Record<string, unknown>;
    const start = bucketRecord["start"];
    const group = bucketRecord["group"];
    const count = bucketRecord["count"];
    return (
      typeof start === "string" &&
      Number.isFinite(Date.parse(start)) &&
      (group === null || typeof group === "string") &&
      Number.isSafeInteger(count) &&
      (count as number) >= 0
    );
  });
}

function immutableCounters(
  mutable: MutableAggregationCounters,
  unresolvedRequests: number,
): AggregationCounters {
  const counters: AggregationCounters = { ...mutable, unresolvedRequests };
  if (counters.scheduledTicks !== counters.startedRequests + counters.missedTicks) {
    throw new Error("Aggregation scheduling accounting invariant failed.");
  }
  if (counters.startedRequests !== counters.completedRequests + counters.unresolvedRequests) {
    throw new Error("Aggregation terminal accounting invariant failed.");
  }
  if (
    counters.completedRequests !==
    counters.successfulResponses +
      counters.httpFailures +
      counters.timeoutFailures +
      counters.transportFailures +
      counters.invalidResponses
  ) {
    throw new Error("Aggregation outcome accounting invariant failed.");
  }
  return counters;
}

export interface AggregationScheduler {
  stop(measuredEndMs: number): Promise<AggregationResult>;
}

export function startAggregationScheduler(input: {
  readonly measuredStartMs: number;
  readonly clock: MonotonicClock;
  readonly sleep: Sleep;
  readonly send: SendAggregationRequest;
  readonly intervalMs?: number;
  readonly maximumInFlight?: number;
  readonly drainTimeoutMs?: number;
  readonly abortGraceMs?: number;
  readonly signal?: AbortSignal;
}): AggregationScheduler {
  const intervalMs = input.intervalMs ?? 1_000;
  const maximumInFlight = input.maximumInFlight ?? 4;
  const drainTimeoutMs = input.drainTimeoutMs ?? 10_000;
  const abortGraceMs = input.abortGraceMs ?? 1_000;
  const counters: MutableAggregationCounters = {
    scheduledTicks: 0,
    startedRequests: 0,
    completedRequests: 0,
    successfulResponses: 0,
    httpFailures: 0,
    timeoutFailures: 0,
    transportFailures: 0,
    invalidResponses: 0,
    missedTicks: 0,
  };
  const successfulLatencies: number[] = [];
  const terminalLatencies: number[] = [];
  const schedulingLag: number[] = [];
  const inFlight = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const state = { stopping: false, measuredEndMs: Number.POSITIVE_INFINITY };
  const isAborted = (): boolean => input.signal?.aborted === true;
  const isStopping = (): boolean => state.stopping;
  const shouldStop = (deadline: number): boolean =>
    isStopping() || deadline >= state.measuredEndMs || isAborted();

  const dispatch = (deadlineMs: number): void => {
    counters.scheduledTicks += 1;
    const now = input.clock.now();
    schedulingLag.push(Math.max(0, now - deadlineMs));
    if (inFlight.size >= maximumInFlight || input.signal?.aborted === true) {
      counters.missedTicks += 1;
      return;
    }
    counters.startedRequests += 1;
    const requestStartedAtMs = input.clock.now();
    const controller = new AbortController();
    controllers.add(controller);
    const externalAbort = (): void => {
      controller.abort();
    };
    input.signal?.addEventListener("abort", externalAbort, { once: true });
    const request = input
      .send(controller.signal)
      .then((result) => {
        counters.completedRequests += 1;
        terminalLatencies.push(result.latencyMs);
        if (result.kind === "success") {
          counters.successfulResponses += 1;
          successfulLatencies.push(result.latencyMs);
        } else if (result.kind === "http") counters.httpFailures += 1;
        else if (result.kind === "timeout") counters.timeoutFailures += 1;
        else if (result.kind === "transport") counters.transportFailures += 1;
        else counters.invalidResponses += 1;
      })
      .catch(() => {
        counters.completedRequests += 1;
        counters.transportFailures += 1;
        terminalLatencies.push(Math.max(0, input.clock.now() - requestStartedAtMs));
      })
      .finally(() => {
        controllers.delete(controller);
        inFlight.delete(request);
        input.signal?.removeEventListener("abort", externalAbort);
      });
    inFlight.add(request);
  };

  const accountTicksMissedAtStop = (firstTick: number): void => {
    let tick = firstTick;
    for (;;) {
      const deadline = input.measuredStartMs + tick * intervalMs;
      if (deadline >= state.measuredEndMs) return;
      counters.scheduledTicks += 1;
      counters.missedTicks += 1;
      schedulingLag.push(Math.max(0, state.measuredEndMs - deadline));
      tick += 1;
    }
  };

  const schedulingLoop = (async (): Promise<void> => {
    let tick = 0;
    for (;;) {
      if (isStopping()) {
        accountTicksMissedAtStop(tick);
        return;
      }
      if (isAborted()) return;
      const deadline = input.measuredStartMs + tick * intervalMs;
      const delay = deadline - input.clock.now();
      if (delay > 0) {
        try {
          await input.sleep(delay, input.signal);
        } catch {
          return;
        }
      }
      if (isStopping()) {
        accountTicksMissedAtStop(tick);
        return;
      }
      if (shouldStop(deadline)) return;
      dispatch(deadline);
      tick += 1;
      const nextDeadline = input.measuredStartMs + tick * intervalMs;
      const now = input.clock.now();
      if (now >= nextDeadline) {
        const skippedTicks = Math.floor((now - nextDeadline) / intervalMs) + 1;
        counters.scheduledTicks += skippedTicks;
        counters.missedTicks += skippedTicks;
        for (let skipped = 0; skipped < skippedTicks; skipped += 1) {
          schedulingLag.push(now - (nextDeadline + skipped * intervalMs));
        }
        tick += skippedTicks;
      }
    }
  })();

  return {
    stop: async (endMs) => {
      state.measuredEndMs = endMs;
      state.stopping = true;
      await schedulingLoop;
      const drainStarted = input.clock.now();
      let drainTimedOut = false;
      while (inFlight.size > 0 && input.clock.now() - drainStarted < drainTimeoutMs) {
        try {
          await input.sleep(Math.min(25, drainTimeoutMs), input.signal);
        } catch {
          break;
        }
      }
      if (inFlight.size > 0) {
        drainTimedOut = true;
        for (const controller of controllers) controller.abort();
        await Promise.resolve();
        await Promise.race([Promise.allSettled([...inFlight]), input.sleep(abortGraceMs)]);
      }
      const elapsedMs = Math.max(0, endMs - input.measuredStartMs);
      const countersResult = immutableCounters(counters, inFlight.size);
      return {
        counters: countersResult,
        intendedRatePerSecond: 1,
        achievedStartRatePerSecond: ratePerSecond(countersResult.startedRequests, elapsedMs),
        requestLatencySuccessful: summarizeSamples(
          successfulLatencies,
          "No successful aggregation responses were recorded.",
        ),
        requestLatencyAllTerminal: summarizeSamples(
          terminalLatencies,
          "No aggregation requests reached a terminal outcome.",
        ),
        schedulingLag: summarizeSamples(schedulingLag, "No aggregation ticks were scheduled."),
        drainTimedOut,
      };
    },
  };
}
