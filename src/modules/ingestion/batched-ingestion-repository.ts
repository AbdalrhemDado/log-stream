import type { LogInsertionRecord } from "../../domain/log-entry.js";
import { TransientServiceError } from "../../shared/app-error.js";
import type { IngestionRepository } from "./ingestion-repository.js";

const DEFAULT_FLUSH_DELAY_MS = 2;
const DEFAULT_MAX_BATCH_ROWS = 2_500;
const DEFAULT_MAX_QUEUED_ROWS = 150_000;
const DEFAULT_MAX_CONCURRENT_WRITES = 4;

interface PendingWrite {
  readonly records: readonly LogInsertionRecord[];
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export interface IngestionBatchTimer {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface BatchedIngestionRepository extends IngestionRepository {
  close(): Promise<void>;
}

export interface BatchedIngestionRepositoryOptions {
  readonly repository: IngestionRepository;
  readonly flushDelayMs?: number;
  readonly maxBatchRows?: number;
  readonly maxQueuedRows?: number;
  readonly maxConcurrentWrites?: number;
  readonly timer?: IngestionBatchTimer;
}

const systemTimer: IngestionBatchTimer = {
  schedule(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function readPositiveInteger(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new Error("Ingestion batching limits must be positive safe integers.");
  }
  return candidate;
}

function readDelay(value: number | undefined): number {
  const candidate = value ?? DEFAULT_FLUSH_DELAY_MS;
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new Error("Ingestion batch delay must be a non-negative safe integer.");
  }
  return candidate;
}

function combineRecords(writes: readonly PendingWrite[], rowCount: number): LogInsertionRecord[] {
  const combined = new Array<LogInsertionRecord>(rowCount);
  let index = 0;

  for (const write of writes) {
    for (const record of write.records) {
      combined[index] = record;
      index += 1;
    }
  }

  return combined;
}

export function createBatchedIngestionRepository(
  options: BatchedIngestionRepositoryOptions,
): BatchedIngestionRepository {
  const flushDelayMs = readDelay(options.flushDelayMs);
  const maxBatchRows = readPositiveInteger(options.maxBatchRows, DEFAULT_MAX_BATCH_ROWS);
  const maxQueuedRows = readPositiveInteger(options.maxQueuedRows, DEFAULT_MAX_QUEUED_ROWS);
  const maxConcurrentWrites = readPositiveInteger(
    options.maxConcurrentWrites,
    DEFAULT_MAX_CONCURRENT_WRITES,
  );
  const timer = options.timer ?? systemTimer;
  const pending: PendingWrite[] = [];
  const closeWaiters: (() => void)[] = [];
  let queuedRows = 0;
  let activeWrites = 0;
  let scheduledFlush: { readonly handle: unknown } | undefined;
  let closed = false;

  const settleClose = (): void => {
    if (!closed || pending.length > 0 || activeWrites > 0) {
      return;
    }

    for (const resolve of closeWaiters.splice(0)) {
      resolve();
    }
  };

  const takeBatch = (): { readonly writes: PendingWrite[]; readonly rowCount: number } => {
    const writes: PendingWrite[] = [];
    let rowCount = 0;

    while (pending.length > 0) {
      const next = pending[0];
      if (next === undefined) {
        break;
      }

      if (writes.length > 0 && rowCount + next.records.length > maxBatchRows) {
        break;
      }

      pending.shift();
      writes.push(next);
      rowCount += next.records.length;
      queuedRows -= next.records.length;

      if (rowCount >= maxBatchRows) {
        break;
      }
    }

    return { writes, rowCount };
  };

  let startAvailableWrites = (): void => undefined;

  const scheduleFlush = (delayMs: number): void => {
    if (pending.length === 0 || activeWrites >= maxConcurrentWrites) {
      return;
    }

    if (scheduledFlush !== undefined) {
      if (delayMs !== 0) {
        return;
      }
      timer.cancel(scheduledFlush.handle);
    }

    scheduledFlush = {
      handle: timer.schedule(() => {
        scheduledFlush = undefined;
        startAvailableWrites();
      }, delayMs),
    };
  };

  const startWrite = (writes: readonly PendingWrite[], rowCount: number): void => {
    activeWrites += 1;
    const records = combineRecords(writes, rowCount);

    void Promise.resolve()
      .then(async () => options.repository.insert(records))
      .then(
        () => {
          for (const write of writes) {
            write.resolve();
          }
        },
        (error: unknown) => {
          for (const write of writes) {
            write.reject(error);
          }
        },
      )
      .finally(() => {
        activeWrites -= 1;
        if (pending.length > 0) {
          scheduleFlush(closed || queuedRows >= maxBatchRows ? 0 : flushDelayMs);
        }
        settleClose();
      });
  };

  startAvailableWrites = (): void => {
    while (activeWrites < maxConcurrentWrites && pending.length > 0) {
      const batch = takeBatch();
      startWrite(batch.writes, batch.rowCount);

      if (!closed && queuedRows < maxBatchRows) {
        break;
      }
    }

    if (pending.length > 0 && activeWrites < maxConcurrentWrites) {
      scheduleFlush(closed || queuedRows >= maxBatchRows ? 0 : flushDelayMs);
    }
  };

  return {
    insert(records): Promise<void> {
      if (records.length === 0) {
        return Promise.resolve();
      }

      if (closed || (queuedRows > 0 && queuedRows + records.length > maxQueuedRows)) {
        return Promise.reject(new TransientServiceError());
      }

      const result = new Promise<void>((resolve, reject) => {
        pending.push({ records, resolve, reject });
        queuedRows += records.length;
      });

      if (activeWrites < maxConcurrentWrites && pending.length === 1) {
        startAvailableWrites();
      } else {
        scheduleFlush(queuedRows >= maxBatchRows ? 0 : flushDelayMs);
      }
      return result;
    },

    close(): Promise<void> {
      if (closed && pending.length === 0 && activeWrites === 0) {
        return Promise.resolve();
      }

      closed = true;
      if (scheduledFlush !== undefined) {
        timer.cancel(scheduledFlush.handle);
        scheduledFlush = undefined;
      }
      startAvailableWrites();

      if (pending.length === 0 && activeWrites === 0) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        closeWaiters.push(resolve);
      });
    },
  };
}
