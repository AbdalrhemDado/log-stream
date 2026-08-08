import { describe, expect, it, vi } from "vitest";

import {
  installServerLifecycle,
  type ShutdownSignal,
  type ShutdownSignalSource,
} from "../../src/server-lifecycle.js";

function createSignalSource(): {
  readonly source: ShutdownSignalSource;
  emit(signal: ShutdownSignal): void;
} {
  const listeners = new Map<ShutdownSignal, Set<() => void>>();
  const source: ShutdownSignalSource = {
    on(signal, handler): void {
      const signalListeners = listeners.get(signal) ?? new Set<() => void>();
      signalListeners.add(handler);
      listeners.set(signal, signalListeners);
    },
    off(signal, handler): void {
      listeners.get(signal)?.delete(handler);
    },
  };

  return {
    source,
    emit(signal): void {
      for (const listener of listeners.get(signal) ?? []) {
        listener();
      }
    },
  };
}

describe("server lifecycle", () => {
  it.each(["SIGTERM", "SIGINT"] as const)("closes the application after %s", async (signal) => {
    const signals = createSignalSource();
    const closeApplication = vi.fn(() => Promise.resolve());
    const lifecycle = installServerLifecycle({
      signalSource: signals.source,
      closeApplication,
      onShutdownFailed: vi.fn(),
    });

    signals.emit(signal);

    await vi.waitFor(() => {
      expect(lifecycle.state).toBe("closed");
    });
    expect(closeApplication).toHaveBeenCalledTimes(1);
  });

  it("shares one close operation across repeated and competing shutdown calls", async () => {
    const signals = createSignalSource();
    let releaseClose: (() => void) | undefined;
    const closeApplication = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        }),
    );
    const lifecycle = installServerLifecycle({
      signalSource: signals.source,
      closeApplication,
      onShutdownFailed: vi.fn(),
    });

    const first = lifecycle.shutdown("SIGTERM");
    const second = lifecycle.shutdown("SIGINT");

    expect(second).toBe(first);
    expect(closeApplication).toHaveBeenCalledTimes(1);

    releaseClose?.();
    await first;

    expect(lifecycle.state).toBe("closed");
  });

  it("records shutdown failure without terminating the test process", async () => {
    const signals = createSignalSource();
    const failure = new Error("close failed with private detail");
    const onShutdownFailed = vi.fn();
    const lifecycle = installServerLifecycle({
      signalSource: signals.source,
      closeApplication: () => Promise.reject(failure),
      onShutdownFailed,
    });

    await lifecycle.shutdown("SIGTERM");

    expect(lifecycle.state).toBe("failed");
    expect(onShutdownFailed).toHaveBeenCalledWith(failure, "SIGTERM");
  });
});
