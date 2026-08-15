import { describe, expect, it, vi } from "vitest";

import { validateLogEntry } from "../../src/domain/log-entry-validator.js";
import type { LogId, LogInsertionRecord } from "../../src/domain/log-entry.js";
import {
  createBatchedIngestionRepository,
  type IngestionBatchTimer,
} from "../../src/modules/ingestion/batched-ingestion-repository.js";
import type { IngestionRepository } from "../../src/modules/ingestion/ingestion-repository.js";
import { TransientServiceError } from "../../src/shared/app-error.js";

function record(sequence: number): LogInsertionRecord {
  const validated = validateLogEntry(
    {
      timestamp: "2026-08-14T00:00:00.000Z",
      level: "info",
      service: "checkout",
      message: `message-${String(sequence)}`,
      attributes: {},
    },
    Date.UTC(2026, 7, 14, 0, 0, 0),
  );
  if (!validated.ok) {
    throw new Error("Test fixture failed validation.");
  }

  return {
    ...validated.value,
    id: `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}` as LogId,
  };
}

function manualTimer(): {
  readonly timer: IngestionBatchTimer;
  readonly scheduled: { readonly callback: () => void; readonly delayMs: number }[];
} {
  const scheduled: { readonly callback: () => void; readonly delayMs: number }[] = [];
  return {
    scheduled,
    timer: {
      schedule(callback, delayMs) {
        const entry = { callback, delayMs };
        scheduled.push(entry);
        return entry;
      },
      cancel(handle) {
        const index = scheduled.indexOf(
          handle as { readonly callback: () => void; readonly delayMs: number },
        );
        if (index >= 0) {
          scheduled.splice(index, 1);
        }
      },
    },
  };
}

async function runNextTimer(
  scheduled: { readonly callback: () => void; readonly delayMs: number }[],
): Promise<void> {
  const entry = scheduled.shift();
  if (entry === undefined) {
    throw new Error("Expected a scheduled ingestion flush.");
  }
  entry.callback();
  await vi.waitFor(() => undefined);
}

describe("batched ingestion repository", () => {
  it("starts available lanes immediately then coalesces the queued backlog", async () => {
    const clock = manualTimer();
    const commits: (() => void)[] = [];
    const insert = vi.fn(
      (records: readonly LogInsertionRecord[]) =>
        new Promise<void>((resolve) => {
          void records;
          commits.push(resolve);
        }),
    );
    const repository: IngestionRepository = { insert };
    const batched = createBatchedIngestionRepository({
      repository,
      timer: clock.timer,
      flushDelayMs: 2,
      maxConcurrentWrites: 1,
    });
    let secondResolved = false;
    let thirdResolved = false;

    const first = batched.insert([record(1)]);
    await vi.waitFor(() => {
      expect(insert).toHaveBeenCalledOnce();
    });
    const second = batched.insert([record(2)]).then(() => {
      secondResolved = true;
    });
    const third = batched.insert([record(3)]).then(() => {
      thirdResolved = true;
    });

    expect(clock.scheduled).toHaveLength(0);
    commits.shift()?.();
    await first;
    await vi.waitFor(() => {
      expect(clock.scheduled).toHaveLength(1);
    });
    expect(clock.scheduled).toHaveLength(1);
    expect(clock.scheduled[0]?.delayMs).toBe(2);
    await runNextTimer(clock.scheduled);

    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert.mock.calls[1]?.[0].map((item) => item.id)).toEqual([record(2).id, record(3).id]);
    expect(secondResolved).toBe(false);
    expect(thirdResolved).toBe(false);

    commits.shift()?.();
    await Promise.all([second, third]);
    expect(secondResolved).toBe(true);
    expect(thirdResolved).toBe(true);
  });

  it("does not split an oversized public request", async () => {
    const clock = manualTimer();
    const insert = vi.fn((records: readonly LogInsertionRecord[]) => {
      void records;
      return Promise.resolve();
    });
    const batched = createBatchedIngestionRepository({
      repository: { insert },
      timer: clock.timer,
      maxBatchRows: 3,
      maxConcurrentWrites: 1,
    });

    const oversized = batched.insert([record(1), record(2), record(3), record(4)]);
    await oversized;

    expect(insert).toHaveBeenCalledOnce();
    expect(insert.mock.calls[0]?.[0]).toHaveLength(4);
  });

  it("propagates one transaction failure to every coalesced request", async () => {
    const clock = manualTimer();
    const failure = new Error("write failed");
    let releaseFirst: (() => void) | undefined;
    let call = 0;
    const batched = createBatchedIngestionRepository({
      repository: {
        insert: () => {
          call += 1;
          return call === 1
            ? new Promise<void>((resolve) => {
                releaseFirst = resolve;
              })
            : Promise.reject(failure);
        },
      },
      timer: clock.timer,
      maxConcurrentWrites: 1,
    });

    const first = batched.insert([record(1)]);
    const second = batched.insert([record(2)]);
    const third = batched.insert([record(3)]);
    await vi.waitFor(() => {
      expect(call).toBe(1);
    });
    releaseFirst?.();
    await first;
    await vi.waitFor(() => {
      expect(clock.scheduled).toHaveLength(1);
    });
    await runNextTimer(clock.scheduled);

    await expect(second).rejects.toBe(failure);
    await expect(third).rejects.toBe(failure);
  });

  it("bounds queued work while allowing one oversized public request", async () => {
    const clock = manualTimer();
    let releaseActive: (() => void) | undefined;
    const batched = createBatchedIngestionRepository({
      repository: {
        insert: () =>
          new Promise<void>((resolve) => {
            releaseActive = resolve;
          }),
      },
      timer: clock.timer,
      maxBatchRows: 100,
      maxQueuedRows: 2,
      maxConcurrentWrites: 1,
    });

    const oversized = batched.insert([record(1), record(2), record(3)]);
    const queued = batched.insert([record(4), record(5)]);
    await expect(batched.insert([record(6)])).rejects.toBeInstanceOf(TransientServiceError);
    releaseActive?.();
    await expect(oversized).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(clock.scheduled).toHaveLength(1);
    });
    await runNextTimer(clock.scheduled);
    releaseActive?.();
    await expect(queued).resolves.toBeUndefined();
  });

  it("drains queued work during close and rejects later requests", async () => {
    const clock = manualTimer();
    const insert = vi.fn((records: readonly LogInsertionRecord[]) => {
      void records;
      return Promise.resolve();
    });
    const batched = createBatchedIngestionRepository({
      repository: { insert },
      timer: clock.timer,
    });
    const pending = batched.insert([record(1)]);

    const close = batched.close();
    await pending;
    await close;

    expect(insert).toHaveBeenCalledOnce();
    await expect(batched.insert([record(2)])).rejects.toBeInstanceOf(TransientServiceError);
  });

  it("rejects invalid tuning values", () => {
    const repository: IngestionRepository = { insert: () => Promise.resolve() };

    expect(() => createBatchedIngestionRepository({ repository, flushDelayMs: -1 })).toThrow();
    expect(() => createBatchedIngestionRepository({ repository, maxBatchRows: 0 })).toThrow();
    expect(() => createBatchedIngestionRepository({ repository, maxQueuedRows: 0 })).toThrow();
    expect(() =>
      createBatchedIngestionRepository({ repository, maxConcurrentWrites: 0 }),
    ).toThrow();
  });
});
