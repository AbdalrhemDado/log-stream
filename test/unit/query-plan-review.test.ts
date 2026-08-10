import { describe, expect, it, vi } from "vitest";

import {
  assertAggregationReconciliation,
  assertDatasetBoundaryReconciliation,
  assertDatasetReconciliation,
  assertListReconciliation,
  calculateEstimateRatio,
  calculateExpectedDatasetBoundaries,
  calculateExpectedDatasetCounts,
  closePreservingPrimaryError,
  createExplainCapture,
  createQueryScenarios,
  describeGitSourceState,
  EXPLAIN_PREFIX,
  parseExplainRows,
  parseQueryPlanOptions,
  type QueryPlanReport,
  QueryPlanVerificationError,
  serializeQueryPlanReport,
  summarizeExplainDocument,
} from "../../tools/benchmark/query-plan-review.js";

function explainRows(
  plan: Record<string, unknown>,
  planning: Record<string, unknown> = {},
  additional: Record<string, unknown> = {},
) {
  return [
    {
      "QUERY PLAN": [
        {
          ...additional,
          Plan: plan,
          Planning: planning,
          "Planning Time": 1.25,
          "Execution Time": 4.5,
          Settings: {},
        },
      ],
    },
  ];
}

function basePlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "Node Type": "Limit",
    "Plan Rows": 101,
    "Actual Rows": 101,
    "Actual Loops": 1,
    ...overrides,
  };
}

function reportFixture(): QueryPlanReport {
  return {
    schemaVersion: 1,
    run: {
      timestampUtc: "2026-08-10T00:00:00.000Z",
      baseCommit: "070c61d25c78b001ded711a5f5365a446902bfc2",
      branch: "feat/log-aggregation",
      workingTreeDirty: true,
      task63PathsUncommitted: true,
      sourceState: "Task 6.3 query-plan paths have uncommitted changes.",
    },
    environment: { nodeVersion: "v24.18.0" },
    dockerControls: {
      nanoCpus: 1_000_000_000,
      memoryBytes: 1_073_741_824,
      autoRemove: true,
      persistentMountCount: 0,
    },
    applicationProcess: {
      constrainedToCompanyLimit: false,
      note: "Host process.",
    },
    configuration: { rows: 1_000_000 },
    postgresSettings: { TimeZone: "UTC" },
    database: {},
    queries: [],
    verifiedObservations: [],
    limitations: [],
    unverifiedRequirements: [],
  };
}

describe("query-plan CLI", () => {
  it("uses the reproducible defaults", () => {
    expect(parseQueryPlanOptions([])).toEqual({
      seed: 20_260_810,
      rows: 1_000_000,
      output: "docs/performance/results/query-plan-baseline.json",
    });
  });

  it("accepts seed zero and the approved maxima", () => {
    expect(
      parseQueryPlanOptions([
        "--seed",
        "4294967295",
        "--rows",
        "1000000",
        "--output",
        "evidence.json",
      ]),
    ).toEqual({ seed: 4_294_967_295, rows: 1_000_000, output: "evidence.json" });
    expect(parseQueryPlanOptions(["--seed", "0"]).seed).toBe(0);
  });

  it.each([
    ["unknown", ["--other", "1"]],
    ["duplicate", ["--seed", "1", "--seed", "2"]],
    ["missing", ["--rows"]],
    ["fractional", ["--rows", "1.5"]],
    ["signed", ["--seed", "+1"]],
    ["negative", ["--rows", "-1"]],
    ["padded", ["--rows", " 1"]],
    ["partial", ["--rows", "10rows"]],
    ["unsafe", ["--seed", "9007199254740992"]],
    ["zero rows", ["--rows", "0"]],
    ["too many rows", ["--rows", "1000001"]],
    ["positional", ["rows", "1"]],
    ["empty output", ["--output", ""]],
    ["padded output", ["--output", " evidence.json"]],
    ["non-json output", ["--output", "evidence.txt"]],
  ])("rejects %s CLI input", (_name, arguments_) => {
    expect(() => parseQueryPlanOptions(arguments_)).toThrow();
  });

  it.each([
    [["--unknown-sentinel"], "unknown-sentinel"],
    [["--unknown-sentinel", "--seed"], "unknown-sentinel"],
    [["--unknown-sentinel", "value"], "unknown-sentinel"],
    [["--seed", "123-sentinel"], "123-sentinel"],
    [["--output", "sentinel-output.txt"], "sentinel-output"],
    [["sentinel-position", "value"], "sentinel-position"],
  ])("does not reflect rejected CLI input", (arguments_, sentinel) => {
    try {
      parseQueryPlanOptions(arguments_);
      throw new Error("Expected query-plan CLI parsing to fail.");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(sentinel);
    }
  });
});

describe("fixed workload", () => {
  it("builds the six scenarios from one reference timestamp", () => {
    const scenarios = createQueryScenarios(Date.parse("2026-08-10T12:00:00.000Z"));
    expect(scenarios.map((scenario) => scenario.id)).toEqual([
      "recent-unfiltered-list",
      "service-time-list",
      "level-time-list",
      "attribute-filtered-list",
      "literal-message-search-list",
      "primary-aggregation",
    ]);
    expect(scenarios[0]?.query).toMatchObject({
      since: "2026-08-09T12:00:00.000Z",
      until: "2026-08-10T12:00:00.000Z",
    });
    expect(scenarios[4]?.query["q"]).toBe("nEeDlE_%\\pAtH");
    expect(scenarios[5]?.query).toEqual({
      since: "2026-08-09T12:00:00.000Z",
      until: "2026-08-10T12:00:00.000Z",
      bucket: "5m",
      group_by: "service",
    });
  });

  it("calculates independent deterministic distribution counts", () => {
    expect(calculateExpectedDatasetCounts(1_000, 0)).toEqual({
      rows: 1_000,
      emptyAttributes: 100,
      service007: 10,
      errorLevel: 250,
      tenant000123: 1,
      messageMarker: 1,
    });
  });

  it("calculates exact microsecond boundaries and touched partitions", () => {
    expect(
      calculateExpectedDatasetBoundaries(1_000_000, Date.parse("2026-08-10T11:25:21.418Z")),
    ).toEqual({
      minimumTimestamp: "2026-07-11T11:25:21.418000Z",
      maximumTimestamp: "2026-08-10T11:25:18.826000Z",
      partitionCount: 31,
    });
  });
});

describe("EXPLAIN boundary and analysis", () => {
  it("uses the exact trusted EXPLAIN prefix", () => {
    expect(EXPLAIN_PREFIX).toBe("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, SETTINGS) ");
  });

  it("prefixes production SQL once and forwards the original parameter array unchanged", async () => {
    const parameters: unknown[] = ["service-007", "2026-08-10T00:00:00.000Z", 101];
    const query = vi.fn((sql: string, queryParameters?: unknown[]) => {
      void sql;
      void queryParameters;
      return Promise.resolve({ rows: explainRows(basePlan()) });
    });
    const capture = createExplainCapture({ query });

    await expect(
      capture.database.query("SELECT * FROM logs WHERE service = $1", parameters),
    ).resolves.toEqual({
      rows: [],
    });
    expect(query).toHaveBeenCalledWith(
      `${EXPLAIN_PREFIX}SELECT * FROM logs WHERE service = $1`,
      parameters,
    );
    expect(query.mock.calls[0]?.[1]).toBe(parameters);
    expect(capture.readCapture()).toMatchObject({
      sql: "SELECT * FROM logs WHERE service = $1",
      parameters,
    });
    await expect(capture.database.query("SELECT 2", [])).rejects.toThrow(
      QueryPlanVerificationError,
    );
  });

  it("preserves additional safe top-level FORMAT JSON evidence", async () => {
    const futureEvidence = { Functions: 2, Timing: 0.25 };
    const query = vi.fn((sql: string, queryParameters?: unknown[]) => {
      void sql;
      void queryParameters;
      return Promise.resolve({ rows: explainRows(basePlan(), {}, { JIT: futureEvidence }) });
    });
    const capture = createExplainCapture({ query });
    await capture.database.query("SELECT 1", []);
    expect(capture.readCapture().document["JIT"]).toBe(futureEvidence);
  });

  it("fails if capture is read before a query executes", () => {
    const capture = createExplainCapture({
      query: vi.fn((sql: string, queryParameters?: unknown[]) => {
        void sql;
        void queryParameters;
        return Promise.resolve({ rows: [] });
      }),
    });
    expect(() => capture.readCapture()).toThrow(QueryPlanVerificationError);
  });

  it("extracts scans, partitions, estimates, buffers, and removed subplans", () => {
    const document = parseExplainRows(
      explainRows(
        basePlan({
          "Shared Hit Blocks": 50,
          "Shared Read Blocks": 4,
          Plans: [
            {
              "Node Type": "Index Scan",
              "Plan Rows": 90,
              "Actual Rows": 100,
              "Actual Loops": 1,
              "Relation Name": "logs_20260810",
              Alias: "logs_1",
              "Index Name": "logs_20260810_service_timestamp_id_idx",
              "Index Cond": "service = $1",
              "Subplans Removed": 30,
              "Shared Hit Blocks": 48,
              "Shared Read Blocks": 4,
            },
            {
              "Node Type": "Index Scan",
              "Plan Rows": 50,
              "Actual Rows": 0,
              "Actual Loops": 0,
              "Relation Name": "logs_20260809",
              "Index Name": "logs_20260809_pkey",
            },
            {
              "Node Type": "Seq Scan",
              "Plan Rows": 1,
              "Actual Rows": 0,
              "Actual Loops": 0,
              "Relation Name": "logs_default",
            },
          ],
        }),
        { "Shared Hit Blocks": 3, "Shared Read Blocks": 1 },
      ),
    );
    const summary = summarizeExplainDocument(document);
    expect(summary.topLevelNodeType).toBe("Limit");
    expect(summary.scanTypes).toEqual(["Index Scan", "Seq Scan"]);
    expect(summary.partitionsPlanned).toEqual(["logs_20260809", "logs_20260810", "logs_default"]);
    expect(summary.partitionsExecuted).toEqual(["logs_20260810"]);
    expect(summary.defaultPartitionPlanned).toBe(true);
    expect(summary.defaultPartitionExecuted).toBe(false);
    expect(summary.subplansRemoved).toBe(30);
    expect(summary.rootBuffers).toMatchObject({ sharedHit: 50, sharedRead: 4 });
    expect(summary.planningBuffers).toMatchObject({ sharedHit: 3, sharedRead: 1 });
    expect(summary.nodes[1]).toMatchObject({
      estimateToActualRatio: 0.9,
      hasIndexCondition: true,
      indexName: "logs_20260810_service_timestamp_id_idx",
    });
  });

  it.each([
    ["external sort", { "Sort Method": "external merge", "Sort Space Used": 42 }],
    ["temporary blocks", { "Temp Written Blocks": 1 }],
    ["hash batches", { "HashAgg Batches": 2 }],
    ["disk usage", { "Disk Usage": 64 }],
  ])("detects a %s spill", (_name, fields) => {
    const summary = summarizeExplainDocument(parseExplainRows(explainRows(basePlan(fields))));
    expect(summary.spillDetected).toBe(true);
  });

  it("retains in-memory sort and grouping details without a false spill", () => {
    const summary = summarizeExplainDocument(
      parseExplainRows(
        explainRows(
          basePlan({
            "Node Type": "Aggregate",
            Strategy: "Hashed",
            "Group Key": ["service"],
            "HashAgg Batches": 1,
            "Peak Memory Usage": 512,
            Plans: [
              {
                "Node Type": "Sort",
                "Plan Rows": 10,
                "Actual Rows": 10,
                "Actual Loops": 1,
                "Sort Key": ["timestamp"],
                "Sort Method": "quicksort",
                "Sort Space Used": 64,
                "Sort Space Type": "Memory",
              },
            ],
          }),
        ),
      ),
    );
    expect(summary.spillDetected).toBe(false);
    expect(summary.nodes[0]).toMatchObject({
      strategy: "Hashed",
      groupKey: ["service"],
      hashAggBatches: 1,
      peakMemoryUsageKb: 512,
    });
    expect(summary.nodes[1]).toMatchObject({
      sortMethod: "quicksort",
      sortSpaceType: "Memory",
    });
  });

  it("preserves Incremental Sort evidence when PostgreSQL supplies it", () => {
    const fullSortGroups = {
      "Group Count": 2,
      "Sort Methods Used": ["quicksort"],
      "Sort Space Memory": { Average: 32, Peak: 48 },
    };
    const preSortedGroups = {
      "Group Count": 1,
      "Sort Methods Used": ["quicksort"],
      "Sort Space Memory": { Average: 16, Peak: 16 },
    };
    const summary = summarizeExplainDocument(
      parseExplainRows(
        explainRows(
          basePlan({
            "Node Type": "Incremental Sort",
            "Presorted Key": ["logs.timestamp"],
            "Full-sort Groups": fullSortGroups,
            "Pre-sorted Groups": preSortedGroups,
          }),
        ),
      ),
    );
    expect(summary.incrementalSortOccurred).toBe(true);
    expect(summary.nodes[0]?.incrementalSort).toEqual({
      presortedKey: ["logs.timestamp"],
      fullSortGroups,
      preSortedGroups,
    });
  });

  it("handles zero-row estimate ratios deliberately", () => {
    expect(calculateEstimateRatio(0, 0)).toBe(1);
    expect(calculateEstimateRatio(10, 0)).toBeNull();
    expect(() => calculateEstimateRatio(-1, 1)).toThrow(QueryPlanVerificationError);
  });

  const malformedExplainRows: readonly (readonly unknown[])[] = [
    [],
    [{}],
    [{ "QUERY PLAN": [] }],
    [{ "QUERY PLAN": [{ Plan: {}, "Planning Time": 1, "Execution Time": 1 }] }],
    [
      {
        "QUERY PLAN": [{ Plan: basePlan(), "Planning Time": Number.NaN, "Execution Time": 1 }],
      },
    ],
    [
      {
        "QUERY PLAN": [
          {
            Plan: basePlan(),
            Planning: {},
            Settings: "invalid",
            "Planning Time": 1,
            "Execution Time": 1,
          },
        ],
      },
    ],
  ];

  it("rejects malformed EXPLAIN rows", () => {
    for (const rows of malformedExplainRows) {
      expect(() => summarizeExplainDocument(parseExplainRows(rows))).toThrow(
        QueryPlanVerificationError,
      );
    }
  });
});

describe("reconciliation", () => {
  const observed = {
    rows: 1_000,
    emptyAttributes: 100,
    service007: 10,
    errorLevel: 250,
    tenant000123: 1,
    messageMarker: 1,
    defaultPartitionRows: 0,
    minimumTimestamp: "2026-07-11T00:00:00.000000Z",
    maximumTimestamp: "2026-08-09T23:59:00.000000Z",
    partitionCount: 30,
  };

  it("accepts exact dataset, list, and aggregation reconciliation", () => {
    expect(() => {
      assertDatasetReconciliation(calculateExpectedDatasetCounts(1_000, 0), observed);
    }).not.toThrow();
    expect(() => {
      assertDatasetBoundaryReconciliation(
        {
          minimumTimestamp: observed.minimumTimestamp,
          maximumTimestamp: observed.maximumTimestamp,
          partitionCount: observed.partitionCount,
        },
        observed,
      );
    }).not.toThrow();
    expect(() => {
      assertListReconciliation(500, 101, 101, 100);
    }).not.toThrow();
    expect(() => {
      assertAggregationReconciliation(500, 20, 500, 20);
    }).not.toThrow();
  });

  it("rejects dataset count and default-partition mismatches", () => {
    expect(() => {
      assertDatasetReconciliation(calculateExpectedDatasetCounts(1_000, 0), {
        ...observed,
        service007: 9,
      });
    }).toThrow(QueryPlanVerificationError);
    expect(() => {
      assertDatasetReconciliation(calculateExpectedDatasetCounts(1_000, 0), {
        ...observed,
        defaultPartitionRows: 1,
      });
    }).toThrow(QueryPlanVerificationError);
    expect(() => {
      assertDatasetBoundaryReconciliation(
        {
          minimumTimestamp: observed.minimumTimestamp,
          maximumTimestamp: observed.maximumTimestamp,
          partitionCount: 29,
        },
        observed,
      );
    }).toThrow(QueryPlanVerificationError);
  });

  it("rejects list count and plan mismatches", () => {
    expect(() => {
      assertListReconciliation(500, 100, 101, 100);
    }).toThrow(QueryPlanVerificationError);
    expect(() => {
      assertListReconciliation(500, 101, 100, 100);
    }).toThrow(QueryPlanVerificationError);
  });

  it("rejects aggregation count, result, and plan mismatches", () => {
    expect(() => {
      assertAggregationReconciliation(500, 20, 499, 20);
    }).toThrow(QueryPlanVerificationError);
    expect(() => {
      assertAggregationReconciliation(500, 20, 500, 19);
    }).toThrow(QueryPlanVerificationError);
  });
});

describe("source state and safe publication data", () => {
  it("derives committed and uncommitted Task 6.3 wording from Git status", () => {
    expect(describeGitSourceState("?? tools/benchmark/query-plan-review.ts\n")).toEqual({
      workingTreeDirty: true,
      task63PathsUncommitted: true,
      sourceState: "Task 6.3 query-plan paths have uncommitted changes.",
    });
    expect(describeGitSourceState(" M README.md\n")).toEqual({
      workingTreeDirty: true,
      task63PathsUncommitted: false,
      sourceState: "The working tree is dirty, but Task 6.3 query-plan paths are committed.",
    });
    expect(describeGitSourceState("")).toEqual({
      workingTreeDirty: false,
      task63PathsUncommitted: false,
      sourceState: "The working tree is clean and Task 6.3 query-plan paths are committed.",
    });
  });

  it("serializes safe evidence without over-broad key rejection", () => {
    expect(JSON.parse(serializeQueryPlanReport(reportFixture()))).toMatchObject({
      schemaVersion: 1,
    });
    expect(() => {
      serializeQueryPlanReport({
        ...reportFixture(),
        environment: {
          important: "kept",
          reportName: "kept",
          secretariat: "kept",
          portability: "kept",
          platform: "win32",
          postgresVersion: "16.14",
        },
      });
    }).not.toThrow();
  });

  it.each([
    "password",
    "databasePassword",
    "credential",
    "apiSecret",
    "connectionUrl",
    "databaseUri",
    "connectionString",
    "mappedPort",
    "port",
    "hostPort",
  ])("rejects the unsafe report field %s", (key) => {
    expect(() => {
      serializeQueryPlanReport({
        ...reportFixture(),
        environment: { [key]: "sentinel" },
      });
    }).toThrow(QueryPlanVerificationError);
  });

  it.each([
    "postgresql://example.invalid/database",
    "postgres://example.invalid/database",
    "https://example.invalid/evidence",
    "file:///unsafe/evidence",
  ])("rejects the unsafe report URI value %s", (uri) => {
    expect(() => {
      serializeQueryPlanReport({
        ...reportFixture(),
        environment: { note: uri },
      });
    }).toThrow(QueryPlanVerificationError);
  });

  it("preserves a primary error and reports a lone cleanup failure", async () => {
    const primary = new Error("primary");
    const cleanup = new Error("safe cleanup");
    await expect(
      closePreservingPrimaryError(async () => Promise.reject(new Error("raw")), primary, cleanup),
    ).resolves.toBe(primary);
    await expect(
      closePreservingPrimaryError(async () => Promise.reject(new Error("raw")), undefined, cleanup),
    ).resolves.toBe(cleanup);
  });
});

describe("runner import safety", () => {
  it("blocks publication after runtime-pool cleanup failure", async () => {
    const { finalizeQueryPlanReview, QueryPlanExecutionError } =
      await import("../../tools/benchmark/run-query-plan-review.js");
    const publish = vi.fn(() => Promise.resolve());
    const cleanupContainer = vi.fn(() => Promise.resolve());
    await expect(
      finalizeQueryPlanReview({
        result: { ok: true },
        primaryError: undefined,
        closeRuntime: () => Promise.reject(new Error("raw pool cleanup")),
        cleanupContainer,
        publish,
      }),
    ).rejects.toBeInstanceOf(QueryPlanExecutionError);
    expect(cleanupContainer).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it("blocks publication after container cleanup failure", async () => {
    const { finalizeQueryPlanReview, QueryPlanExecutionError } =
      await import("../../tools/benchmark/run-query-plan-review.js");
    const publish = vi.fn(() => Promise.resolve());
    await expect(
      finalizeQueryPlanReview({
        result: { ok: true },
        primaryError: undefined,
        closeRuntime: () => Promise.resolve(),
        cleanupContainer: () => Promise.reject(new Error("raw cleanup")),
        publish,
      }),
    ).rejects.toBeInstanceOf(QueryPlanExecutionError);
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes only after successful runtime and container cleanup", async () => {
    const { finalizeQueryPlanReview } =
      await import("../../tools/benchmark/run-query-plan-review.js");
    const publish = vi.fn(() => Promise.resolve());
    const result = { ok: true };
    await expect(
      finalizeQueryPlanReview({
        result,
        primaryError: undefined,
        closeRuntime: () => Promise.resolve(),
        cleanupContainer: () => Promise.resolve(),
        publish,
      }),
    ).resolves.toBe(result);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("preserves an existing safe primary error through cleanup failures", async () => {
    const { finalizeQueryPlanReview, QueryPlanExecutionError } =
      await import("../../tools/benchmark/run-query-plan-review.js");
    const primary = new QueryPlanExecutionError("Safe primary failure.");
    const publish = vi.fn(() => Promise.resolve());
    await expect(
      finalizeQueryPlanReview({
        result: { ok: true },
        primaryError: primary,
        closeRuntime: () => Promise.reject(new Error("raw pool cleanup")),
        cleanupContainer: () => Promise.reject(new Error("raw container cleanup")),
        publish,
      }),
    ).rejects.toBe(primary);
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not start Docker or publish evidence when imported", async () => {
    vi.resetModules();
    const spawn = vi.fn(() => {
      throw new Error("spawn must not run during import");
    });
    const writeFile = vi.fn(() => {
      throw new Error("writeFile must not run during import");
    });
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const original = await importOriginal<typeof import("node:fs/promises")>();
      return { ...original, writeFile };
    });

    const runner = await import("../../tools/benchmark/run-query-plan-review.js");
    expect(runner.isDirectEsmEntry(import.meta.url, undefined)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();

    vi.doUnmock("node:child_process");
    vi.doUnmock("node:fs/promises");
  });
});
