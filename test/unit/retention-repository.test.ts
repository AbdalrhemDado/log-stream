import { describe, expect, it, vi } from "vitest";

import { InternalDatabaseError } from "../../src/database/database-errors.js";
import { buildPartitionPlan } from "../../src/database/partitions/partition-plan.js";
import type { CanonicalUtcTimestamp } from "../../src/domain/log-entry.js";
import {
  createRetentionRepository,
  type RetentionDatabaseClient,
  type RetentionDatabasePool,
  type RetentionRunRequest,
} from "../../src/modules/retention/retention-repository.js";
import { TransientServiceError } from "../../src/shared/app-error.js";

const REFERENCE = "2026-08-12T12:34:56.000Z" as CanonicalUtcTimestamp;
const CUTOFF = "2026-07-13T12:34:56.000Z" as CanonicalUtcTimestamp;

function partitions() {
  return buildPartitionPlan(new Date(REFERENCE), 1).slice(1);
}

function request(overrides: Partial<RetentionRunRequest> = {}): RetentionRunRequest {
  return {
    referenceTime: REFERENCE,
    cutoff: CUTOFF,
    partitions: partitions(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface DatabaseBehavior {
  readonly lock?: boolean;
  readonly ensure?: readonly boolean[];
  readonly drop?: readonly boolean[];
  readonly deleted?: readonly number[];
  readonly unlock?: boolean;
  readonly onQuery?: (sql: string) => void;
  readonly rejectWhen?: (sql: string) => Error | undefined;
}

function database(behavior: DatabaseBehavior = {}) {
  let ensureIndex = 0;
  let dropIndex = 0;
  let deleteIndex = 0;
  const release = vi.fn();
  const query = vi.fn(
    async (sql: string, parameters?: unknown[]): Promise<{ readonly rows: readonly unknown[] }> => {
      await Promise.resolve();
      void parameters;
      behavior.onQuery?.(sql);
      const rejection = behavior.rejectWhen?.(sql);
      if (rejection !== undefined) {
        throw rejection;
      }
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: behavior.lock ?? true }] };
      }
      if (sql.includes("ensure_log_partition")) {
        const value = behavior.ensure?.[ensureIndex] ?? false;
        ensureIndex += 1;
        return { rows: [{ created: value }] };
      }
      if (sql.includes("drop_one_expired")) {
        const values = behavior.drop ?? [false];
        const value = values[Math.min(dropIndex, values.length - 1)] ?? false;
        dropIndex += 1;
        return { rows: [{ dropped: value }] };
      }
      if (sql.includes("delete_expired_default")) {
        const values = behavior.deleted ?? [0];
        const value = values[Math.min(deleteIndex, values.length - 1)] ?? 0;
        deleteIndex += 1;
        return { rows: [{ deleted: value }] };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [{ released: behavior.unlock ?? true }] };
      }
      throw new Error("Unexpected SQL in retention test double.");
    },
  );
  const client: RetentionDatabaseClient = { query, release };
  const connect = vi.fn(() => Promise.resolve(client));
  const pool: RetentionDatabasePool = { connect };
  return { pool, client, connect, query, release };
}

describe("retention repository input boundary", () => {
  it("honors an already-aborted signal without acquiring a client", async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = database();

    await expect(
      createRetentionRepository(harness.pool).run(request({ signal: controller.signal })),
    ).resolves.toMatchObject({ status: "aborted", partitionEnsureCalls: 0 });
    expect(harness.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["noncanonical reference", { referenceTime: "2026-08-12T12:34:56Z" }],
    ["invalid cutoff", { cutoff: "invalid" }],
    ["two partitions", { partitions: partitions().slice(0, 2) }],
    ["wrong order", { partitions: partitions().toReversed() }],
    ["duplicates", { partitions: [partitions()[0], partitions()[0], partitions()[2]] }],
  ])("rejects $name before pool acquisition", async (_name, overrides) => {
    const harness = database();
    const repository = createRetentionRepository(harness.pool);

    await expect(
      repository.run(request(overrides as Partial<RetentionRunRequest>)),
    ).rejects.toBeInstanceOf(InternalDatabaseError);
    expect(harness.connect).not.toHaveBeenCalled();
  });

  it.each(["name", "start", "end"] as const)(
    "rejects an accessor-backed partition %s without invoking it",
    async (key) => {
      const forged = { ...partitions()[0] };
      let calls = 0;
      Object.defineProperty(forged, key, {
        enumerable: true,
        get: () => {
          calls += 1;
          return "submitted-secret";
        },
      });
      const harness = database();

      await expect(
        createRetentionRepository(harness.pool).run(
          request({ partitions: [forged as never, ...partitions().slice(1)] }),
        ),
      ).rejects.toBeInstanceOf(InternalDatabaseError);
      expect(calls).toBe(0);
      expect(harness.connect).not.toHaveBeenCalled();
    },
  );

  it("rejects inherited partition fields", async () => {
    const original = partitions()[0];
    const inherited = Object.assign(Object.create({ name: original?.name }) as object, {
      start: original?.start,
      end: original?.end,
    });
    const harness = database();

    await expect(
      createRetentionRepository(harness.pool).run(
        request({ partitions: [inherited as never, ...partitions().slice(1)] }),
      ),
    ).rejects.toBeInstanceOf(InternalDatabaseError);
    expect(harness.connect).not.toHaveBeenCalled();
  });

  it("rejects boxed and coercible partition fields without coercion", async () => {
    let coercions = 0;
    const coercible = {
      toString: () => {
        coercions += 1;
        return partitions()[0]?.name;
      },
      valueOf: () => {
        coercions += 1;
        return partitions()[0]?.name;
      },
      [Symbol.toPrimitive]: () => {
        coercions += 1;
        return partitions()[0]?.name;
      },
    };
    const first = { ...partitions()[0], name: coercible };
    const boxed = { ...partitions()[1], start: new String(partitions()[1]?.start) };
    const harness = database();

    await expect(
      createRetentionRepository(harness.pool).run(
        request({ partitions: [first, boxed, partitions()[2]] as never }),
      ),
    ).rejects.toBeInstanceOf(InternalDatabaseError);
    expect(coercions).toBe(0);
    expect(harness.connect).not.toHaveBeenCalled();
  });

  it("rejects an accessor-backed request field without invoking it", async () => {
    const forged = { ...request() };
    let calls = 0;
    Object.defineProperty(forged, "cutoff", {
      enumerable: true,
      get: () => {
        calls += 1;
        return CUTOFF;
      },
    });
    const harness = database();

    await expect(createRetentionRepository(harness.pool).run(forged)).rejects.toBeInstanceOf(
      InternalDatabaseError,
    );
    expect(calls).toBe(0);
    expect(harness.connect).not.toHaveBeenCalled();
  });
});

describe("retention repository maintenance", () => {
  it("uses one client, bound lock keys, ordered partitions, and normal release", async () => {
    const harness = database({ ensure: [true, false, true], drop: [false], deleted: [7] });
    const repository = createRetentionRepository(harness.pool);

    await expect(repository.run(request())).resolves.toEqual({
      status: "completed",
      partitionEnsureCalls: 3,
      partitionsCreated: 2,
      partitionDropCalls: 1,
      partitionsDropped: 0,
      defaultCleanupCalls: 1,
      defaultRowsDeleted: 7,
      partitionDropBudgetReached: false,
      defaultDeleteBudgetReached: false,
    });
    expect(harness.connect).toHaveBeenCalledOnce();
    expect(harness.query.mock.calls[0]).toEqual([
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      [1_815_642_963, 2],
    ]);
    const ensureCalls = harness.query.mock.calls.filter(([sql]) =>
      sql.includes("ensure_log_partition"),
    );
    expect(ensureCalls.map((call) => call[1])).toEqual(
      partitions().map((partition) => [partition.start]),
    );
    expect(harness.release).toHaveBeenCalledWith();
  });

  it("returns a safe skip after lock contention", async () => {
    const harness = database({ lock: false });

    await expect(createRetentionRepository(harness.pool).run(request())).resolves.toEqual({
      status: "skipped",
      partitionEnsureCalls: 0,
      partitionsCreated: 0,
      partitionDropCalls: 0,
      partitionsDropped: 0,
      defaultCleanupCalls: 0,
      defaultRowsDeleted: 0,
      partitionDropBudgetReached: false,
      defaultDeleteBudgetReached: false,
    });
    expect(harness.query).toHaveBeenCalledOnce();
    expect(harness.release).toHaveBeenCalledWith();
  });

  it.each([
    { name: "before limit", drops: [true, false], calls: 2, dropped: 1 },
    { name: "on limit", drops: [...Array<boolean>(31).fill(true), false], calls: 32, dropped: 31 },
  ])("does not mark the partition budget when false occurs $name", async (scenario) => {
    const harness = database({ drop: scenario.drops });
    const result = await createRetentionRepository(harness.pool).run(request());

    expect(result.partitionDropCalls).toBe(scenario.calls);
    expect(result.partitionsDropped).toBe(scenario.dropped);
    expect(result.partitionDropBudgetReached).toBe(false);
  });

  it("marks the partition budget only when call 32 drops a partition", async () => {
    const harness = database({ drop: Array<boolean>(32).fill(true) });
    const result = await createRetentionRepository(harness.pool).run(request());

    expect(result.partitionDropCalls).toBe(32);
    expect(result.partitionsDropped).toBe(32);
    expect(result.partitionDropBudgetReached).toBe(true);
    expect(result.defaultCleanupCalls).toBe(1);
  });

  it("stops default cleanup on a short batch without marking the budget", async () => {
    const harness = database({ deleted: [1_000, 999] });
    const result = await createRetentionRepository(harness.pool).run(request());

    expect(result.defaultCleanupCalls).toBe(2);
    expect(result.defaultRowsDeleted).toBe(1_999);
    expect(result.defaultDeleteBudgetReached).toBe(false);
  });

  it("does not mark the default budget when the tenth batch is short", async () => {
    const harness = database({ deleted: [...Array<number>(9).fill(1_000), 999] });
    const result = await createRetentionRepository(harness.pool).run(request());

    expect(result.defaultCleanupCalls).toBe(10);
    expect(result.defaultRowsDeleted).toBe(9_999);
    expect(result.defaultDeleteBudgetReached).toBe(false);
  });

  it("marks the default budget only when the tenth batch is full", async () => {
    const harness = database({ deleted: Array<number>(10).fill(1_000) });
    const result = await createRetentionRepository(harness.pool).run(request());

    expect(result.defaultCleanupCalls).toBe(10);
    expect(result.defaultRowsDeleted).toBe(10_000);
    expect(result.defaultDeleteBudgetReached).toBe(true);
  });

  it("returns partial bounded counts when aborted between operations", async () => {
    const controller = new AbortController();
    let ensured = 0;
    const harness = database({
      onQuery: (sql) => {
        if (sql.includes("ensure_log_partition")) {
          ensured += 1;
          if (ensured === 1) {
            controller.abort();
          }
        }
      },
    });

    const result = await createRetentionRepository(harness.pool).run(
      request({ signal: controller.signal }),
    );

    expect(result).toMatchObject({ status: "aborted", partitionEnsureCalls: 1 });
    expect(harness.query.mock.calls.some(([sql]) => sql.includes("drop_one"))).toBe(false);
    expect(harness.release).toHaveBeenCalledWith();
  });
});

describe("retention repository failures and cleanup", () => {
  it("preserves transient classification and unlocks before normal release", async () => {
    const source = Object.assign(new Error("postgresql://runtime:secret@database/logstream"), {
      code: "ECONNRESET",
    });
    const harness = database({
      rejectWhen: (sql) => (sql.includes("ensure_log_partition") ? source : undefined),
    });

    let thrown: unknown;
    try {
      await createRetentionRepository(harness.pool).run(request());
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TransientServiceError);
    expect(String(thrown)).not.toContain("secret");
    expect(thrown).not.toHaveProperty("cause");
    expect(harness.query.mock.calls.some(([sql]) => sql.includes("advisory_unlock"))).toBe(true);
    expect(harness.release).toHaveBeenCalledWith();
  });

  it("destructively releases after uncertain lock acquisition", async () => {
    const harness = database({
      rejectWhen: (sql) => (sql.includes("pg_try_advisory_lock") ? new Error("raw") : undefined),
    });

    await expect(createRetentionRepository(harness.pool).run(request())).rejects.toBeInstanceOf(
      InternalDatabaseError,
    );
    expect(harness.release).toHaveBeenCalledWith(true);
  });

  it("destructively releases after unlock failure", async () => {
    const harness = database({ unlock: false });

    await expect(createRetentionRepository(harness.pool).run(request())).rejects.toBeInstanceOf(
      InternalDatabaseError,
    );
    expect(harness.release).toHaveBeenCalledWith(true);
  });

  it("preserves the primary safe error through unlock failure", async () => {
    const source = Object.assign(new Error("private connection"), { code: "ECONNRESET" });
    const harness = database({
      rejectWhen: (sql) => {
        if (sql.includes("ensure_log_partition")) {
          return source;
        }
        if (sql.includes("pg_advisory_unlock")) {
          return new Error("unlock detail");
        }
        return undefined;
      },
    });

    await expect(createRetentionRepository(harness.pool).run(request())).rejects.toBeInstanceOf(
      TransientServiceError,
    );
    expect(harness.release).toHaveBeenCalledWith(true);
  });

  it("turns a client-release failure into a safe database error", async () => {
    const harness = database();
    harness.release.mockImplementationOnce(() => {
      throw new Error("private pool detail");
    });

    let thrown: unknown;
    try {
      await createRetentionRepository(harness.pool).run(request());
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InternalDatabaseError);
    expect(String(thrown)).not.toContain("private pool detail");
  });

  it("rejects an impossible default-deletion count and still unlocks safely", async () => {
    const harness = database({ deleted: [1_001] });

    await expect(createRetentionRepository(harness.pool).run(request())).rejects.toBeInstanceOf(
      InternalDatabaseError,
    );
    expect(harness.query.mock.calls.some(([sql]) => sql.includes("advisory_unlock"))).toBe(true);
    expect(harness.release).toHaveBeenCalledWith();
  });

  it.each([
    {
      name: "accessor",
      row: Object.defineProperty({}, "created", { enumerable: true, get: vi.fn() }),
    },
    { name: "boxed", row: { created: new Boolean(true) } },
    { name: "wrong type", row: { created: "true" } },
  ])("rejects a malformed database result: $name", async ({ row }) => {
    const harness = database();
    harness.query.mockImplementationOnce(() => Promise.resolve({ rows: [{ acquired: true }] }));
    harness.query.mockImplementationOnce(() => Promise.resolve({ rows: [row] }));
    harness.query.mockImplementationOnce(() => Promise.resolve({ rows: [{ released: true }] }));

    await expect(createRetentionRepository(harness.pool).run(request())).rejects.toBeInstanceOf(
      InternalDatabaseError,
    );
    expect(harness.release).toHaveBeenCalledWith();
  });
});
