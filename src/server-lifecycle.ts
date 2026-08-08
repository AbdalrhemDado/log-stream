export type ShutdownSignal = "SIGINT" | "SIGTERM";
export type ShutdownState = "running" | "closing" | "closed" | "failed";

type SignalHandler = () => void;

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ShutdownSignalSource {
  on(signal: ShutdownSignal, handler: SignalHandler): void;
  off(signal: ShutdownSignal, handler: SignalHandler): void;
}

export interface ShutdownTimer {
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface ServerLifecycleOptions {
  readonly signalSource: ShutdownSignalSource;
  readonly markNotReady?: () => void;
  readonly closeApplication: () => Promise<void>;
  readonly closeDatabase?: () => Promise<void>;
  readonly shutdownTimeoutMs?: number;
  readonly timer?: ShutdownTimer;
  readonly forceExit?: (exitCode: number) => void;
  readonly onShutdownStarted?: (signal: ShutdownSignal) => void;
  readonly onShutdownFailed: (error: unknown, signal: ShutdownSignal) => void;
}

export interface ServerLifecycle {
  readonly state: ShutdownState;
  shutdown(signal: ShutdownSignal): Promise<void>;
  dispose(): void;
}

export class ShutdownTimeoutError extends Error {
  public constructor(timeoutMs: number) {
    super(`Application shutdown exceeded its ${String(timeoutMs)}ms deadline.`);
    this.name = "ShutdownTimeoutError";
  }
}

const systemTimer: ShutdownTimer = {
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(handle);
    };
  },
};

function callSafely(callback: () => void): void {
  try {
    callback();
  } catch {
    // Lifecycle reporting must never prevent or duplicate resource closure.
  }
}

async function closeResources(options: ServerLifecycleOptions): Promise<void> {
  let firstFailure: unknown;
  let closureFailed = false;

  try {
    await options.closeApplication();
  } catch (error: unknown) {
    closureFailed = true;
    firstFailure = error;
  }

  try {
    await options.closeDatabase?.();
  } catch (error: unknown) {
    closureFailed = true;
    firstFailure ??= error;
  }

  if (closureFailed) {
    if (firstFailure instanceof Error) {
      throw firstFailure;
    }

    throw new Error("Application resource closure failed.");
  }
}

async function enforceDeadline(
  operation: Promise<void>,
  timeoutMs: number,
  timer: ShutdownTimer,
): Promise<void> {
  let cancelDeadline = (): void => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    cancelDeadline = timer.schedule(() => {
      reject(new ShutdownTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    await Promise.race([operation, deadline]);
  } finally {
    cancelDeadline();
  }
}

export function installServerLifecycle(options: ServerLifecycleOptions): ServerLifecycle {
  let state: ShutdownState = "running";
  let shutdownPromise: Promise<void> | undefined;
  let disposed = false;

  const executeShutdown = async (signal: ShutdownSignal): Promise<void> => {
    state = "closing";
    callSafely(() => {
      options.markNotReady?.();
    });
    callSafely(() => {
      options.onShutdownStarted?.(signal);
    });

    try {
      await enforceDeadline(
        closeResources(options),
        options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
        options.timer ?? systemTimer,
      );
      state = "closed";
    } catch (error: unknown) {
      state = "failed";
      callSafely(() => {
        options.onShutdownFailed(error, signal);
      });

      if (error instanceof ShutdownTimeoutError) {
        callSafely(() => {
          options.forceExit?.(1);
        });
      }
    }
  };

  const shutdown = (signal: ShutdownSignal): Promise<void> => {
    shutdownPromise ??= executeShutdown(signal);
    return shutdownPromise;
  };

  const handlers: Readonly<Record<ShutdownSignal, SignalHandler>> = {
    SIGINT: () => {
      void shutdown("SIGINT");
    },
    SIGTERM: () => {
      void shutdown("SIGTERM");
    },
  };

  options.signalSource.on("SIGINT", handlers.SIGINT);
  options.signalSource.on("SIGTERM", handlers.SIGTERM);

  return {
    get state(): ShutdownState {
      return state;
    },
    shutdown,
    dispose(): void {
      if (disposed) {
        return;
      }

      disposed = true;
      options.signalSource.off("SIGINT", handlers.SIGINT);
      options.signalSource.off("SIGTERM", handlers.SIGTERM);
    },
  };
}
