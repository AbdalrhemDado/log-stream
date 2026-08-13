import type { Pool } from "pg";

const CLIENT_CLOSE_TIMEOUT_MS = 10_000;

export async function endPoolAndWaitForClients(pool: Pool): Promise<void> {
  const expectedRemovals = pool.totalCount;

  if (expectedRemovals === 0) {
    await pool.end();
    return;
  }

  let observedRemovals = 0;
  let resolveRemovals: (() => void) | undefined;
  const allClientsRemoved = new Promise<void>((resolve) => {
    resolveRemovals = resolve;
  });
  const onRemove = (): void => {
    observedRemovals += 1;
    if (observedRemovals === expectedRemovals) {
      resolveRemovals?.();
    }
  };
  pool.on("remove", onRemove);

  let timeout: NodeJS.Timeout | undefined;
  const closeTimeout = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("PostgreSQL test-pool clients did not close before the deadline."));
    }, CLIENT_CLOSE_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      (async () => {
        await pool.end();
        await allClientsRemoved;
      })(),
      closeTimeout,
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    pool.off("remove", onRemove);
  }
}
