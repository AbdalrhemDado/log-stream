export type ShutdownSignal = "SIGINT" | "SIGTERM";
export type ShutdownState = "running" | "closing" | "closed" | "failed";

type SignalHandler = () => void;

export interface ShutdownSignalSource {
  on(signal: ShutdownSignal, handler: SignalHandler): void;
  off(signal: ShutdownSignal, handler: SignalHandler): void;
}

export interface ServerLifecycleOptions {
  readonly signalSource: ShutdownSignalSource;
  readonly closeApplication: () => Promise<void>;
  readonly onShutdownStarted?: (signal: ShutdownSignal) => void;
  readonly onShutdownFailed: (error: unknown, signal: ShutdownSignal) => void;
}

export interface ServerLifecycle {
  readonly state: ShutdownState;
  shutdown(signal: ShutdownSignal): Promise<void>;
  dispose(): void;
}

function callSafely(callback: () => void): void {
  try {
    callback();
  } catch {
    // Lifecycle reporting must never prevent or duplicate application closure.
  }
}

export function installServerLifecycle(options: ServerLifecycleOptions): ServerLifecycle {
  let state: ShutdownState = "running";
  let shutdownPromise: Promise<void> | undefined;
  let disposed = false;

  const executeShutdown = async (signal: ShutdownSignal): Promise<void> => {
    state = "closing";
    callSafely(() => {
      options.onShutdownStarted?.(signal);
    });

    try {
      await options.closeApplication();
      state = "closed";
    } catch (error: unknown) {
      state = "failed";
      callSafely(() => {
        options.onShutdownFailed(error, signal);
      });
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
