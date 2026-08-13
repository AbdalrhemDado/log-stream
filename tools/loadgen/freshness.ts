import type { FreshnessResult, IngestionProbeObservation, MonotonicClock, Sleep } from "./types.js";

export function buildFreshnessUrl(baseUrl: string, probe: IngestionProbeObservation): URL {
  const url = new URL("/logs", `${baseUrl}/`);
  url.searchParams.set("attr.loadgen_run_id", probe.log.attributes.loadgen_run_id);
  url.searchParams.set("attr.loadgen_phase", probe.log.attributes.loadgen_phase);
  url.searchParams.set("attr.loadgen_sequence", probe.log.attributes.loadgen_sequence);
  url.searchParams.set("limit", "1");
  return url;
}

function containsProbe(body: unknown, probe: IngestionProbeObservation): boolean {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const logs = (body as Record<string, unknown>)["logs"];
  if (!Array.isArray(logs)) return false;
  return logs.some((item) => {
    if (typeof item !== "object" || item === null) return false;
    const attributes = (item as Record<string, unknown>)["attributes"];
    const attributeRecord = attributes as Record<string, unknown> | null;
    return (
      attributeRecord !== null &&
      typeof attributeRecord === "object" &&
      attributeRecord["loadgen_run_id"] === probe.log.attributes.loadgen_run_id &&
      attributeRecord["loadgen_phase"] === probe.log.attributes.loadgen_phase &&
      attributeRecord["loadgen_sequence"] === probe.log.attributes.loadgen_sequence
    );
  });
}

export async function observeFreshness(input: {
  readonly baseUrl: string;
  readonly probe: IngestionProbeObservation | null;
  readonly fetch: typeof fetch;
  readonly clock: MonotonicClock;
  readonly sleep: Sleep;
  readonly requestTimeoutMs: number;
  readonly deadlineMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}): Promise<FreshnessResult> {
  if (input.probe?.accepted !== true) {
    return {
      outcome: "probe-not-accepted",
      postDispatchToVisibilityMs: null,
      postAcknowledgementToVisibilityMs: null,
      pollCount: 0,
      pollFailures: 0,
    };
  }
  const deadlineMs = input.deadlineMs ?? 20_000;
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  const scheduleTimeout = input.setTimeout ?? setTimeout;
  const cancelTimeout = input.clearTimeout ?? clearTimeout;
  const expiresAt = input.probe.postDispatchMonotonicMs + deadlineMs;
  let pollCount = 0;
  let pollFailures = 0;
  const url = buildFreshnessUrl(input.baseUrl, input.probe);

  while (input.clock.now() <= expiresAt) {
    if (input.signal?.aborted === true) {
      return {
        outcome: "aborted",
        postDispatchToVisibilityMs: null,
        postAcknowledgementToVisibilityMs: null,
        pollCount,
        pollFailures,
      };
    }
    pollCount += 1;
    const controller = new AbortController();
    const timeout = scheduleTimeout(() => {
      controller.abort();
    }, input.requestTimeoutMs);
    const abort = (): void => {
      controller.abort();
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await input.fetch(url, { signal: controller.signal });
      if (response.ok) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          pollFailures += 1;
          body = undefined;
        }
        if (containsProbe(body, input.probe)) {
          const visibleAt = input.clock.now();
          return {
            outcome: "visible",
            postDispatchToVisibilityMs: visibleAt - input.probe.postDispatchMonotonicMs,
            postAcknowledgementToVisibilityMs:
              visibleAt - (input.probe.postAcknowledgementMonotonicMs ?? visibleAt),
            pollCount,
            pollFailures,
          };
        }
      } else {
        pollFailures += 1;
      }
    } catch {
      pollFailures += 1;
    } finally {
      cancelTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    }
    const remaining = expiresAt - input.clock.now();
    if (remaining <= 0) break;
    try {
      await input.sleep(Math.min(pollIntervalMs, remaining), input.signal);
    } catch {
      return {
        outcome: "aborted",
        postDispatchToVisibilityMs: null,
        postAcknowledgementToVisibilityMs: null,
        pollCount,
        pollFailures,
      };
    }
  }
  return {
    outcome: "deadline-exceeded",
    postDispatchToVisibilityMs: null,
    postAcknowledgementToVisibilityMs: null,
    pollCount,
    pollFailures,
  };
}
