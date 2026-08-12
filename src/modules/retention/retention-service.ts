import { buildPartitionPlan } from "../../database/partitions/partition-plan.js";
import type { CanonicalUtcTimestamp } from "../../domain/log-entry.js";
import type { RetentionRepository, RetentionRunResult } from "./retention-repository.js";

const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3_650;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 86_400_000;
const MILLISECONDS_PER_DAY = 86_400_000;

export class RetentionServiceConfigurationError extends Error {
  public constructor() {
    super("Retention service configuration is invalid.");
    this.name = "RetentionServiceConfigurationError";
  }
}

export interface RetentionClock {
  now(): number;
}

export interface RetentionTimer {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface RetentionLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface RetentionServiceOptions {
  readonly repository: RetentionRepository;
  readonly retentionDays: number;
  readonly retentionIntervalMs: number;
  readonly clock: RetentionClock;
  readonly timer: RetentionTimer;
  readonly logger: RetentionLogger;
}

export interface RetentionService {
  start(): void;
  stop(): Promise<void>;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOwnEnumerableDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor?.enumerable !== true || !("value" in descriptor)) {
    throw new RetentionServiceConfigurationError();
  }

  return descriptor.value;
}

function readFunction(value: object, key: string): (...arguments_: unknown[]) => unknown {
  const candidate = readOwnEnumerableDataProperty(value, key);
  if (typeof candidate !== "function") {
    throw new RetentionServiceConfigurationError();
  }

  return candidate as (...arguments_: unknown[]) => unknown;
}

function readSafeInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RetentionServiceConfigurationError();
  }

  return value;
}

function validateOptions(options: RetentionServiceOptions): RetentionServiceOptions {
  if (!isObject(options)) {
    throw new RetentionServiceConfigurationError();
  }

  const repository = readOwnEnumerableDataProperty(options, "repository");
  const retentionDays = readSafeInteger(
    readOwnEnumerableDataProperty(options, "retentionDays"),
    MIN_RETENTION_DAYS,
    MAX_RETENTION_DAYS,
  );
  const retentionIntervalMs = readSafeInteger(
    readOwnEnumerableDataProperty(options, "retentionIntervalMs"),
    MIN_INTERVAL_MS,
    MAX_INTERVAL_MS,
  );
  const clock = readOwnEnumerableDataProperty(options, "clock");
  const timer = readOwnEnumerableDataProperty(options, "timer");
  const logger = readOwnEnumerableDataProperty(options, "logger");

  if (
    retentionIntervalMs % MIN_INTERVAL_MS !== 0 ||
    !isObject(repository) ||
    !isObject(clock) ||
    !isObject(timer) ||
    !isObject(logger)
  ) {
    throw new RetentionServiceConfigurationError();
  }

  const repositoryRun = readFunction(repository, "run") as RetentionRepository["run"];
  const clockNow = readFunction(clock, "now") as RetentionClock["now"];
  const timerSchedule = readFunction(timer, "schedule") as RetentionTimer["schedule"];
  const timerCancel = readFunction(timer, "cancel");
  const loggerInfo = readFunction(logger, "info") as RetentionLogger["info"];
  const loggerError = readFunction(logger, "error") as RetentionLogger["error"];

  return {
    repository: {
      run: (request) => repositoryRun.call(repository, request),
    },
    retentionDays,
    retentionIntervalMs,
    clock: {
      now: () => clockNow.call(clock),
    },
    timer: {
      schedule: (callback, delayMs) => timerSchedule.call(timer, callback, delayMs),
      cancel: (handle) => {
        timerCancel.call(timer, handle);
      },
    },
    logger: {
      info: (fields, message) => {
        loggerInfo.call(logger, fields, message);
      },
      error: (fields, message) => {
        loggerError.call(logger, fields, message);
      },
    },
  };
}

function buildRunInput(
  now: number,
  retentionDays: number,
  signal: AbortSignal,
): Parameters<RetentionRepository["run"]>[0] {
  if (!Number.isSafeInteger(now) || !Number.isFinite(now)) {
    throw new RetentionServiceConfigurationError();
  }

  const referenceDate = new Date(now);
  const cutoffDate = new Date(now - retentionDays * MILLISECONDS_PER_DAY);
  if (!Number.isFinite(referenceDate.getTime()) || !Number.isFinite(cutoffDate.getTime())) {
    throw new RetentionServiceConfigurationError();
  }

  const completePlan = buildPartitionPlan(referenceDate, 1);
  const partitions = completePlan.slice(1);
  if (partitions.length !== 3) {
    throw new RetentionServiceConfigurationError();
  }

  return {
    referenceTime: referenceDate.toISOString() as CanonicalUtcTimestamp,
    cutoff: cutoffDate.toISOString() as CanonicalUtcTimestamp,
    partitions,
    signal,
  };
}

function logResult(logger: RetentionLogger, result: RetentionRunResult): void {
  try {
    logger.info(
      {
        status: result.status,
        partitionEnsureCalls: result.partitionEnsureCalls,
        partitionsCreated: result.partitionsCreated,
        partitionDropCalls: result.partitionDropCalls,
        partitionsDropped: result.partitionsDropped,
        defaultCleanupCalls: result.defaultCleanupCalls,
        defaultRowsDeleted: result.defaultRowsDeleted,
        partitionDropBudgetReached: result.partitionDropBudgetReached,
        defaultDeleteBudgetReached: result.defaultDeleteBudgetReached,
      },
      "Retention maintenance settled",
    );
  } catch {
    // Logging must not change maintenance scheduling or shutdown behavior.
  }
}

function logFailure(logger: RetentionLogger): void {
  try {
    logger.error({ failureType: "retention-run" }, "Retention maintenance failed");
  } catch {
    // Logging must not change maintenance scheduling or shutdown behavior.
  }
}

export function createRetentionService(
  untrustedOptions: RetentionServiceOptions,
): RetentionService {
  const options = validateOptions(untrustedOptions);
  let started = false;
  let stopping = false;
  let timerScheduled = false;
  let scheduledHandle: unknown;
  let activeController: AbortController | undefined;
  let activeRun: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  const scheduleNext = (): void => {
    if (stopping || timerScheduled) {
      return;
    }

    try {
      scheduledHandle = options.timer.schedule(() => {
        timerScheduled = false;
        scheduledHandle = undefined;
        void beginRun();
      }, options.retentionIntervalMs);
      timerScheduled = true;
    } catch {
      logFailure(options.logger);
    }
  };

  const executeRun = async (controller: AbortController): Promise<void> => {
    try {
      const request = buildRunInput(options.clock.now(), options.retentionDays, controller.signal);
      const result = await options.repository.run(request);
      logResult(options.logger, result);
    } catch {
      logFailure(options.logger);
    } finally {
      activeController = undefined;
      activeRun = undefined;
      scheduleNext();
    }
  };

  const beginRun = (): Promise<void> => {
    if (stopping) {
      return Promise.resolve();
    }
    if (activeRun !== undefined) {
      return activeRun;
    }

    const controller = new AbortController();
    activeController = controller;
    activeRun = Promise.resolve().then(async () => executeRun(controller));
    return activeRun;
  };

  return {
    start(): void {
      if (started || stopping) {
        return;
      }

      started = true;
      void beginRun();
    },
    stop(): Promise<void> {
      stopPromise ??= (async () => {
        stopping = true;
        let primaryError: unknown;
        if (timerScheduled) {
          try {
            options.timer.cancel(scheduledHandle);
          } catch (error: unknown) {
            primaryError = error;
          } finally {
            timerScheduled = false;
            scheduledHandle = undefined;
          }
        }
        activeController?.abort();
        try {
          await activeRun;
        } catch (error: unknown) {
          primaryError ??= error;
        }

        if (primaryError !== undefined) {
          if (primaryError instanceof Error) {
            throw primaryError;
          }
          throw new Error("Retention service shutdown failed.");
        }
      })();
      return stopPromise;
    },
  };
}

export async function stopRetentionBeforeDatabase(
  retentionService: Pick<RetentionService, "stop">,
  closeDatabase: () => Promise<void>,
): Promise<void> {
  let primaryError: unknown;

  try {
    await retentionService.stop();
  } catch (error: unknown) {
    primaryError = error;
  }

  try {
    await closeDatabase();
  } catch (error: unknown) {
    primaryError ??= error;
  }

  if (primaryError !== undefined) {
    if (primaryError instanceof Error) {
      throw primaryError;
    }
    throw new Error("Retention shutdown failed.");
  }
}
