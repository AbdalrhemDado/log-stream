import type { MonotonicClock, Sleep, TerminalHttpOutcome } from "./types.js";

export interface HttpDependencies {
  readonly fetch: typeof fetch;
  readonly clock: MonotonicClock;
  readonly setTimeout: typeof globalThis.setTimeout;
  readonly clearTimeout: typeof globalThis.clearTimeout;
}

export interface TimedHttpResult {
  readonly outcome: TerminalHttpOutcome;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly latencyMs: number;
}

export function defaultSleep(durationMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("Sleep aborted."));
      return;
    }
    const timer = setTimeout(resolve, durationMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Sleep aborted."));
      },
      { once: true },
    );
  });
}

export const systemClock: MonotonicClock = {
  now: () => performance.now(),
};

export async function requestJson(
  input: {
    readonly url: URL;
    readonly method: "GET" | "POST";
    readonly timeoutMs: number;
    readonly body?: unknown;
    readonly externalSignal?: AbortSignal;
  },
  dependencies: HttpDependencies,
): Promise<TimedHttpResult> {
  const controller = new AbortController();
  const timeoutState = { triggered: false };
  const onExternalAbort = (): void => {
    controller.abort();
  };
  input.externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  if (input.externalSignal?.aborted === true) controller.abort();
  const timeout = dependencies.setTimeout(() => {
    timeoutState.triggered = true;
    controller.abort();
  }, input.timeoutMs);
  const startedAtMs = dependencies.clock.now();

  try {
    const response = await dependencies.fetch(input.url, {
      method: input.method,
      signal: controller.signal,
      ...(input.body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(input.body) }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const completedAtMs = dependencies.clock.now();
      return {
        outcome: { kind: "http", status: response.status },
        startedAtMs,
        completedAtMs,
        latencyMs: Math.max(0, completedAtMs - startedAtMs),
      };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      const completedAtMs = dependencies.clock.now();
      return {
        outcome: { kind: "invalid-response", status: response.status },
        startedAtMs,
        completedAtMs,
        latencyMs: Math.max(0, completedAtMs - startedAtMs),
      };
    }
    const completedAtMs = dependencies.clock.now();
    return {
      outcome: { kind: "success", status: response.status, body },
      startedAtMs,
      completedAtMs,
      latencyMs: Math.max(0, completedAtMs - startedAtMs),
    };
  } catch {
    const completedAtMs = dependencies.clock.now();
    return {
      outcome: { kind: timeoutState.triggered ? "timeout" : "transport" },
      startedAtMs,
      completedAtMs,
      latencyMs: Math.max(0, completedAtMs - startedAtMs),
    };
  } finally {
    dependencies.clearTimeout(timeout);
    input.externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

export type { Sleep };
