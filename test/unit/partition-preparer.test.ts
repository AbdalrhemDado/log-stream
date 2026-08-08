import { describe, expect, it } from "vitest";

import type {
  MigrationDatabase,
  MigrationQueryResult,
} from "../../src/database/migrations/migration-types.js";
import { buildPartitionPlan } from "../../src/database/partitions/partition-plan.js";
import {
  buildPartitionStructuralSql,
  preparePartitions,
} from "../../src/database/partitions/partition-preparer.js";

interface QueryCall {
  readonly sql: string;
  readonly parameters: unknown[] | undefined;
}

class PartitionDatabase implements MigrationDatabase {
  public readonly calls: QueryCall[] = [];

  public constructor(
    private readonly existingNames: readonly string[] = [],
    private readonly overlap = false,
  ) {}

  public query(sql: string, parameters?: unknown[]): Promise<MigrationQueryResult> {
    this.calls.push({ sql, parameters });
    if (sql.includes("pg_try_advisory_lock")) {
      return Promise.resolve({ rows: [{ acquired: true }] });
    }
    if (sql.includes("pg_advisory_unlock")) {
      return Promise.resolve({ rows: [{ released: true }] });
    }
    if (sql.includes("SELECT child.relname AS name")) {
      return Promise.resolve({ rows: this.existingNames.map((name) => ({ name })) });
    }
    if (sql.includes("SELECT EXISTS")) {
      return Promise.resolve({ rows: [{ has_overlap: this.overlap }] });
    }
    return Promise.resolve({ rows: [] });
  }
}

describe("buildPartitionStructuralSql", () => {
  it("builds exact SQL from a validated application-owned UTC partition", () => {
    const [partition] = buildPartitionPlan(new Date("2026-08-08T12:00:00.000Z"), 1);
    if (partition === undefined) {
      throw new Error("Expected a partition.");
    }

    expect(buildPartitionStructuralSql(partition)).toEqual({
      create: `
CREATE TABLE logstream.logs_20260807 (
  LIKE logstream.logs INCLUDING DEFAULTS INCLUDING CONSTRAINTS
);
ALTER TABLE logstream.logs_20260807 OWNER TO logstream_owner;
ALTER TABLE logstream.logs_20260807
  ADD CONSTRAINT logs_20260807_timestamp_bounds
  CHECK (
    timestamp >= TIMESTAMPTZ '2026-08-07T00:00:00.000Z'
    AND timestamp < TIMESTAMPTZ '2026-08-08T00:00:00.000Z'
  ) NOT VALID;
ALTER TABLE logstream.logs_20260807 VALIDATE CONSTRAINT logs_20260807_timestamp_bounds;
REVOKE ALL ON TABLE logstream.logs_20260807 FROM PUBLIC;
REVOKE ALL ON TABLE logstream.logs_20260807 FROM logstream_runtime;
`,
      attach:
        "ALTER TABLE logstream.logs ATTACH PARTITION logstream.logs_20260807 FOR VALUES FROM (TIMESTAMPTZ '2026-08-07T00:00:00.000Z') TO (TIMESTAMPTZ '2026-08-08T00:00:00.000Z')",
    });
  });
});

describe("preparePartitions", () => {
  it("skips partitions that are already attached", async () => {
    const [partition] = buildPartitionPlan(new Date("2026-08-08T12:00:00.000Z"), 1);
    if (partition === undefined) {
      throw new Error("Expected a partition.");
    }
    const database = new PartitionDatabase([partition.name]);

    await preparePartitions({ database, partitions: [partition] });

    expect(database.calls.some((call) => call.sql === "BEGIN")).toBe(false);
  });

  it("prepares missing partitions in deterministic UTC order", async () => {
    const plan = buildPartitionPlan(new Date("2026-08-08T12:00:00.000Z"), 1);
    const database = new PartitionDatabase();

    await preparePartitions({ database, partitions: plan.toReversed() });

    const attachments = database.calls
      .filter((call) => call.sql.includes("ATTACH PARTITION"))
      .map((call) => /logs_[0-9]{8}/u.exec(call.sql)?.[0]);
    expect(attachments).toEqual(plan.map((partition) => partition.name));
  });

  it("uses parameterized bounds when inspecting and moving overlap rows", async () => {
    const [partition] = buildPartitionPlan(new Date("2026-08-08T12:00:00.000Z"), 1);
    if (partition === undefined) {
      throw new Error("Expected a partition.");
    }
    const database = new PartitionDatabase([], true);

    await preparePartitions({ database, partitions: [partition] });

    const overlapCalls = database.calls.filter(
      (call) => call.sql.includes("SELECT EXISTS") || call.sql.includes("WITH moved_rows"),
    );
    expect(overlapCalls).toHaveLength(2);
    expect(overlapCalls.every((call) => call.parameters?.[0] === partition.start)).toBe(true);
    expect(overlapCalls.every((call) => call.parameters?.[1] === partition.end)).toBe(true);
  });
});
