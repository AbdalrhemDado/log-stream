import { describe, expect, it, vi } from "vitest";

import type {
  RetentionRepository,
  RetentionRunResult,
} from "../../src/modules/retention/retention-repository.js";
import {
  createRetentionService,
  RetentionServiceConfigurationError,
  stopRetentionBeforeDatabase,
  type RetentionClock,
  type RetentionLogger,
  type RetentionServiceOptions,
  type RetentionTimer,
} from "../../src/modules/retention/retention-service.js";

const COMPLETED_RESULT: RetentionRunResult = {
  status: "completed",
  partitionEnsureCalls: 3,
  partitionsCreated: 0,
  partitionDropCalls: 1,
  partitionsDropped: 0,
  defaultCleanupCalls: 1,
  defaultRowsDeleted: 0,
  partitionDropBudgetReached: false,
  defaultDeleteBudgetReached: false,
};

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

interface RetentionServiceHarness extends RetentionServiceOptions {
  readonly run: ReturnType<typeof vi.fn<RetentionRepository["run"]>>;
  readonly schedule: ReturnType<typeof vi.fn<RetentionTimer["schedule"]>>;
  readonly cancel: ReturnType<typeof vi.fn<RetentionTimer["cancel"]>>;
  readonly now: ReturnType<typeof vi.fn<RetentionClock["now"]>>;
  readonly info: ReturnType<typeof vi.fn<RetentionLogger["info"]>>;
  readonly error: ReturnType<typeof vi.fn<RetentionLogger["error"]>>;
}

function options(overrides: Partial<RetentionServiceOptions> = {}): RetentionServiceHarness {
  const run = vi.fn<RetentionRepository["run"]>(() => Promise.resolve(COMPLETED_RESULT));
  const schedule = vi.fn<RetentionTimer["schedule"]>(() => "timer-handle");
  const cancel = vi.fn<RetentionTimer["cancel"]>();
  const now = vi.fn<RetentionClock["now"]>(() => Date.parse("2026-08-12T12:34:56.789Z"));
  const info = vi.fn<RetentionLogger["info"]>();
  const error = vi.fn<RetentionLogger["error"]>();
  return {
    repository: { run },
    retentionDays: 30,
    retentionIntervalMs: 3_600_000,
    clock: { now },
    timer: { schedule, cancel },
    logger: { info, error },
    ...overrides,
    run,
    schedule,
    cancel,
    now,
    info,
    error,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("retention service construction boundary", () => {
  it.each([
    ["retentionDays zero", { retentionDays: 0 }],
    ["retentionDays too high", { retentionDays: 3_651 }],
    ["retentionDays fractional", { retentionDays: 1.5 }],
    ["retentionDays boxed", { retentionDays: new Number(30) }],
    ["interval too low", { retentionIntervalMs: 59_999 }],
    ["interval too high", { retentionIntervalMs: 86_400_001 }],
    ["interval not whole minutes", { retentionIntervalMs: 60_001 }],
    ["interval unsafe", { retentionIntervalMs: Number.MAX_SAFE_INTEGER + 1 }],
    ["repository missing run", { repository: {} }],
    ["clock missing now", { clock: {} }],
    ["timer missing cancel", { timer: { schedule: vi.fn() } }],
    ["logger missing error", { logger: { info: vi.fn() } }],
  ])("rejects $name before work begins", (_name, override) => {
    const base = options();

    expect(() => createRetentionService({ ...base, ...override } as never)).toThrow(
      RetentionServiceConfigurationError,
    );
    expect(base.schedule).not.toHaveBeenCalled();
    expect(base.run).not.toHaveBeenCalled();
  });

  it.each(["repository", "timer", "clock", "logger", "retentionDays"] as const)(
    "rejects an accessor-backed %s without invoking it",
    (key) => {
      const base = options();
      const forged = { ...base };
      let calls = 0;
      Object.defineProperty(forged, key, {
        enumerable: true,
        get: () => {
          calls += 1;
          return base[key];
        },
      });

      expect(() => createRetentionService(forged)).toThrow(RetentionServiceConfigurationError);
      expect(calls).toBe(0);
      expect(base.schedule).not.toHaveBeenCalled();
      expect(base.run).not.toHaveBeenCalled();
    },
  );

  it("rejects coercible configuration without invoking hooks", () => {
    let coercions = 0;
    const forged = {
      valueOf: () => {
        coercions += 1;
        return 30;
      },
      toString: () => {
        coercions += 1;
        return "30";
      },
      [Symbol.toPrimitive]: () => {
        coercions += 1;
        return 30;
      },
    };
    const base = options();

    expect(() => createRetentionService({ ...base, retentionDays: forged } as never)).toThrow(
      RetentionServiceConfigurationError,
    );
    expect(coercions).toBe(0);
    expect(base.schedule).not.toHaveBeenCalled();
    expect(base.run).not.toHaveBeenCalled();
  });

  it.each([
    ["repository", "run"],
    ["clock", "now"],
    ["timer", "schedule"],
    ["timer", "cancel"],
    ["logger", "info"],
    ["logger", "error"],
  ] as const)("rejects an accessor-backed %s.%s function without invoking it", (container, key) => {
    const base = options();
    const dependency = { ...base[container] };
    let calls = 0;
    Object.defineProperty(dependency, key, {
      enumerable: true,
      get: () => {
        calls += 1;
        return vi.fn();
      },
    });

    expect(() => createRetentionService({ ...base, [container]: dependency })).toThrow(
      RetentionServiceConfigurationError,
    );
    expect(calls).toBe(0);
    expect(base.schedule).not.toHaveBeenCalled();
    expect(base.run).not.toHaveBeenCalled();
  });
});

describe("retention service scheduling", () => {
  it("captures time once and derives one cutoff plus current and two future partitions", async () => {
    const harness = options();
    const service = createRetentionService(harness);

    service.start();
    await settle();

    expect(harness.now).toHaveBeenCalledOnce();
    expect(harness.run).toHaveBeenCalledOnce();
    const submitted = harness.run.mock.calls[0]?.[0];
    expect(submitted).toMatchObject({
      referenceTime: "2026-08-12T12:34:56.789Z",
      cutoff: "2026-07-13T12:34:56.789Z",
    });
    expect(submitted?.partitions.map((partition) => partition.name)).toEqual([
      "logs_20260812",
      "logs_20260813",
      "logs_20260814",
    ]);
    expect(harness.schedule).toHaveBeenCalledWith(expect.any(Function), 3_600_000);
    await service.stop();
  });

  it("runs immediately once, schedules only after settlement, and does not overlap", async () => {
    const pending = deferred<RetentionRunResult>();
    const run = vi.fn(() => pending.promise);
    const harness = options({ repository: { run } });
    const service = createRetentionService(harness);

    service.start();
    service.start();
    await settle();
    expect(run).toHaveBeenCalledOnce();
    expect(harness.schedule).not.toHaveBeenCalled();

    pending.resolve(COMPLETED_RESULT);
    await settle();
    expect(harness.schedule).toHaveBeenCalledOnce();
    await service.stop();
  });

  it("schedules the next run after a skip or failure", async () => {
    const skipped = { ...COMPLETED_RESULT, status: "skipped" as const };
    const skipHarness = options({ repository: { run: vi.fn(() => Promise.resolve(skipped)) } });
    const failedHarness = options({
      repository: { run: vi.fn(() => Promise.reject(new Error("private database detail"))) },
    });

    createRetentionService(skipHarness).start();
    createRetentionService(failedHarness).start();
    await settle();

    expect(skipHarness.schedule).toHaveBeenCalledOnce();
    expect(failedHarness.schedule).toHaveBeenCalledOnce();
    expect(failedHarness.error).toHaveBeenCalledWith(
      { failureType: "retention-run" },
      "Retention maintenance failed",
    );
    expect(JSON.stringify(failedHarness.error.mock.calls)).not.toContain("private database detail");
  });

  it("recovers from a synchronous clock failure on the next scheduled run", async () => {
    const now = vi
      .fn<RetentionClock["now"]>()
      .mockImplementationOnce(() => {
        throw new Error("private clock detail");
      })
      .mockReturnValue(Date.parse("2026-08-12T12:34:56.789Z"));
    const harness = options({ clock: { now } });
    const service = createRetentionService(harness);

    service.start();
    await settle();
    expect(harness.schedule).toHaveBeenCalledOnce();
    expect(harness.run).not.toHaveBeenCalled();

    const callback = harness.schedule.mock.calls[0]?.[0];
    callback?.();
    await settle();
    expect(harness.run).toHaveBeenCalledOnce();
    await service.stop();
  });

  it("cancels a pending timer idempotently", async () => {
    const harness = options();
    const service = createRetentionService(harness);
    service.start();
    await settle();

    await service.stop();
    await service.stop();

    expect(harness.cancel).toHaveBeenCalledOnce();
    expect(harness.cancel).toHaveBeenCalledWith("timer-handle");
  });

  it("aborts and awaits an active run before stop settles", async () => {
    const operation = deferred<RetentionRunResult>();
    let signal: AbortSignal | undefined;
    const run = vi.fn((request: Parameters<RetentionRepository["run"]>[0]) => {
      signal = request.signal;
      return operation.promise;
    });
    const service = createRetentionService(options({ repository: { run } }));
    service.start();

    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(stopped).toBe(false);

    operation.resolve({ ...COMPLETED_RESULT, status: "aborted" });
    await stopping;
    expect(stopped).toBe(true);
  });

  it("preserves a timer-cancellation failure after clearing the scheduled state", async () => {
    const cancellationFailure = new Error("timer cancellation failed");
    const harness = options({
      timer: {
        schedule: vi.fn(() => "timer-handle"),
        cancel: vi.fn(() => {
          throw cancellationFailure;
        }),
      },
    });
    const service = createRetentionService(harness);
    service.start();
    await settle();

    await expect(service.stop()).rejects.toBe(cancellationFailure);
    await expect(service.stop()).rejects.toBe(cancellationFailure);
  });
});

describe("retention shutdown ordering", () => {
  it("stops retention before closing the database", async () => {
    const order: string[] = [];
    await stopRetentionBeforeDatabase(
      {
        stop: () => {
          order.push("retention");
          return Promise.resolve();
        },
      },
      () => {
        order.push("database");
        return Promise.resolve();
      },
    );

    expect(order).toEqual(["retention", "database"]);
  });

  it("attempts database closure and preserves the first failure", async () => {
    const retentionFailure = new Error("retention failure");
    const databaseFailure = new Error("database failure");
    const closeDatabase = vi.fn(() => Promise.reject(databaseFailure));

    let thrown: unknown;
    try {
      await stopRetentionBeforeDatabase(
        { stop: () => Promise.reject(retentionFailure) },
        closeDatabase,
      );
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBe(retentionFailure);
    expect(closeDatabase).toHaveBeenCalledOnce();
  });
});
