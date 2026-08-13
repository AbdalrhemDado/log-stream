import { EventEmitter } from "node:events";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { endPoolAndWaitForClients } from "../harness/postgres-pool-teardown.js";

function poolHarness(totalCount: number): {
  readonly emitter: EventEmitter;
  readonly end: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly pool: Pool;
} {
  const emitter = new EventEmitter();
  const end = vi.fn(() => Promise.resolve());
  const pool = Object.assign(emitter, { totalCount, end }) as unknown as Pool;

  return { emitter, end, pool };
}

describe("PostgreSQL integration pool teardown", () => {
  it("ends an unused pool without waiting for remove events", async () => {
    const harness = poolHarness(0);

    await expect(endPoolAndWaitForClients(harness.pool)).resolves.toBeUndefined();

    expect(harness.end).toHaveBeenCalledOnce();
    expect(harness.emitter.listenerCount("remove")).toBe(0);
  });

  it("waits for every captured client removal after pool.end resolves", async () => {
    const harness = poolHarness(2);
    let completed = false;
    const closing = endPoolAndWaitForClients(harness.pool).then(() => {
      completed = true;
    });

    await vi.waitFor(() => {
      expect(harness.end).toHaveBeenCalledOnce();
    });
    expect(completed).toBe(false);

    harness.emitter.emit("remove", {});
    await Promise.resolve();
    expect(completed).toBe(false);

    harness.emitter.emit("remove", {});
    await closing;

    expect(completed).toBe(true);
    expect(harness.emitter.listenerCount("remove")).toBe(0);
  });
});
