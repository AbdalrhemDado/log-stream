import type { DatabaseProbe } from "./database-pool.js";

export interface DatabaseWaitClock {
  now(): number;
  sleep(delayMs: number): Promise<void>;
  runWithTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T>;
}

export interface WaitForDatabaseOptions {
  readonly probe: DatabaseProbe;
  readonly timeoutMs: number;
  readonly retryDelayMs: number;
  readonly clock?: DatabaseWaitClock;
}

export interface DatabaseWaitResult {
  readonly attempts: number;
}

export class DatabaseStartupTimeoutError extends Error {
  public constructor() {
    super("Database did not become ready before the startup deadline.");
    this.name = "DatabaseStartupTimeoutError";
  }
}

const systemClock: DatabaseWaitClock = {
  now: () => Date.now(),
  sleep: async (delayMs) =>
    new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    }),
  runWithTimeout: async <T>(operation: Promise<T>, timeoutMs: number): Promise<T> => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new DatabaseStartupTimeoutError());
      }, timeoutMs);
    });

    try {
      return await Promise.race([operation, timeout]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  },
};

export async function waitForDatabase(
  options: WaitForDatabaseOptions,
): Promise<DatabaseWaitResult> {
  const clock = options.clock ?? systemClock;
  const deadline = clock.now() + options.timeoutMs;
  let attempts = 0;

  for (;;) {
    const remainingBeforeAttemptMs = deadline - clock.now();
    if (remainingBeforeAttemptMs <= 0) {
      throw new DatabaseStartupTimeoutError();
    }

    attempts += 1;

    try {
      await clock.runWithTimeout(options.probe(), remainingBeforeAttemptMs);
      return { attempts };
    } catch (error: unknown) {
      if (error instanceof DatabaseStartupTimeoutError) {
        throw error;
      }

      const remainingMs = deadline - clock.now();
      if (remainingMs <= 0) {
        throw new DatabaseStartupTimeoutError();
      }

      await clock.sleep(Math.min(options.retryDelayMs, remainingMs));
    }
  }
}
