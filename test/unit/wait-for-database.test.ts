import { describe, expect, it, vi } from "vitest";

import {
  DatabaseStartupTimeoutError,
  waitForDatabase,
  type DatabaseWaitClock,
} from "../../src/database/wait-for-database.js";

function createClock(): { readonly clock: DatabaseWaitClock; readonly sleeps: number[] } {
  let currentTime = 0;
  const sleeps: number[] = [];

  return {
    clock: {
      now: () => currentTime,
      sleep: (delayMs) => {
        sleeps.push(delayMs);
        currentTime += delayMs;
        return Promise.resolve();
      },
      runWithTimeout: async <T>(operation: Promise<T>): Promise<T> => operation,
    },
    sleeps,
  };
}

describe("waitForDatabase", () => {
  it("succeeds after transient connection failures", async () => {
    const { clock, sleeps } = createClock();
    const probe = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue(undefined);

    const result = await waitForDatabase({
      probe,
      timeoutMs: 1_000,
      retryDelayMs: 100,
      clock,
    });

    expect(result).toEqual({ attempts: 3 });
    expect(sleeps).toEqual([100, 100]);
  });

  it("stops retrying at the startup deadline", async () => {
    const { clock, sleeps } = createClock();
    const probe = vi.fn(() => Promise.reject(new Error("still unavailable")));

    await expect(
      waitForDatabase({
        probe,
        timeoutMs: 250,
        retryDelayMs: 100,
        clock,
      }),
    ).rejects.toBeInstanceOf(DatabaseStartupTimeoutError);

    expect(sleeps).toEqual([100, 100, 50]);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("times out a probe that does not settle before the deadline", async () => {
    const probe = vi.fn(() => new Promise<void>(() => undefined));
    const clock: DatabaseWaitClock = {
      now: () => 0,
      sleep: () => Promise.resolve(),
      runWithTimeout: () => Promise.reject(new DatabaseStartupTimeoutError()),
    };

    await expect(
      waitForDatabase({ probe, timeoutMs: 250, retryDelayMs: 100, clock }),
    ).rejects.toBeInstanceOf(DatabaseStartupTimeoutError);

    expect(probe).toHaveBeenCalledTimes(1);
  });
});
