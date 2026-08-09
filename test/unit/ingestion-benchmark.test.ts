import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { NormalizedSearchAttributes } from "../../src/domain/attributes.js";
import type { ValidatedLogEntry } from "../../src/domain/log-entry.js";
import type { BenchmarkReport } from "../../tools/benchmark/ingestion-benchmark.js";
import {
  assertExpectedCount,
  assertRowReconciliation,
  BenchmarkConfigurationError,
  BenchmarkVerificationError,
  captureMemorySnapshot,
  closePreservingPrimaryError,
  createDeterministicLogId,
  createDeterministicWorkload,
  describeGitSourceState,
  measureNormalization,
  measureValidation,
  nearestRank,
  parseBenchmarkOptions,
  serializeBenchmarkReport,
  summarizeRepositorySamples,
  verifyNormalizationResult,
} from "../../tools/benchmark/ingestion-benchmark.js";

const REFERENCE_TIME_MS = Date.UTC(2026, 7, 10, 12, 0, 0, 0);

function fakeClock(...values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) {
      throw new Error("Test clock exhausted.");
    }
    return value;
  };
}

function normalizationEntries(): readonly ValidatedLogEntry[] {
  return measureValidation(
    [
      {
        timestamp: new Date(REFERENCE_TIME_MS - 1_000).toISOString(),
        level: "info",
        service: "normalization-check",
        message: "representative scalar attributes",
        attributes: {
          text: "unchanged",
          yes: true,
          no: false,
          integer: 42,
          fraction: 1.25,
          exponent: 1e21,
          negativeZero: -0,
        },
      },
    ],
    REFERENCE_TIME_MS,
    fakeClock(1, 2),
  ).values;
}

function normalizedAttributes(
  values: Readonly<Record<string, string>>,
): NormalizedSearchAttributes {
  return Object.assign(
    Object.create(null) as Record<string, string>,
    values,
  ) as NormalizedSearchAttributes;
}

function expectStableNormalizationFailure(operation: () => void): void {
  expect(operation).toThrow(BenchmarkVerificationError);
  expect(operation).toThrow("Normalization benchmark verification failed.");
}

function exampleReport(): BenchmarkReport {
  const memory = {
    rssBytes: 1,
    heapTotalBytes: 2,
    heapUsedBytes: 3,
    externalBytes: 4,
    arrayBuffersBytes: 5,
  };
  return {
    schemaVersion: 1,
    run: {
      timestampUtc: "2026-08-10T12:00:00.000Z",
      baseCommit: "68d89efa1f40ede6b95a1de68dbf82e4356d65fe",
      branch: "feat/ingestion-repository",
      workingTreeDirty: true,
      task43PathsUncommitted: true,
      sourceState: "Test state.",
    },
    environment: {
      nodeVersion: "v24.18.0",
      npmVersion: "11.16.0",
      platform: "win32",
      release: "test",
      architecture: "x64",
      cpuModel: "test CPU",
      logicalCpuCount: 1,
      hostMemoryBytes: 1_073_741_824,
      dockerVersion: "29.6.2",
      postgresImage: "postgres:16.14-bookworm",
      postgresVersion: "16.14",
    },
    dockerControls: {
      nanoCpus: 1_000_000_000,
      memoryBytes: 1_073_741_824,
      autoRemove: true,
      persistentMountCount: 0,
    },
    applicationProcess: {
      constrainedToCompanyLimit: false,
      note: "Test limitation.",
    },
    configuration: {
      seed: 20_260_810,
      batchSize: 1_000,
      warmupBatches: 2,
      measuredBatches: 10,
      warmupRows: 2_000,
      measuredRows: 10_000,
      poolMaximum: 4,
      referenceTimeUtc: "2026-08-10T12:00:00.000Z",
    },
    percentileMethod: "Nearest rank.",
    stages: {
      validation: {
        operationCount: 10_000,
        durationMs: 10,
        throughputPerSecond: 1_000_000,
        checksum: "12345678",
        memoryBefore: memory,
        memoryAfter: memory,
      },
      normalization: {
        operationCount: 10_000,
        durationMs: 10,
        throughputPerSecond: 1_000_000,
        checksum: "87654321",
        memoryBefore: memory,
        memoryAfter: memory,
      },
      repository: {
        batchCount: 10,
        batchSize: 1_000,
        operationCount: 10_000,
        samplesMs: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
        totalDurationMs: 100,
        throughputPerSecond: 100_000,
        batchLatencyP50Ms: 10,
        batchLatencyP95Ms: 10,
        batchLatencyP99Ms: 10,
        expectedRows: 10_000,
        observedRows: 10_000,
        warmupResetObservedRows: 0,
        immediateVisibilityQueryDurationMs: 1,
        memoryBefore: memory,
        memoryAfter: memory,
      },
    },
    limitations: ["Test limitation."],
    unverifiedRequirements: ["PERF-001"],
  };
}

describe("parseBenchmarkOptions", () => {
  it("returns the approved deterministic defaults", () => {
    expect(parseBenchmarkOptions([])).toEqual({
      seed: 20_260_810,
      batchSize: 1_000,
      warmupBatches: 2,
      measuredBatches: 10,
      output: "docs/performance/results/ingestion-microbenchmark-baseline.json",
    });
  });

  it("accepts every supported flag and permits a zero seed", () => {
    expect(
      parseBenchmarkOptions([
        "--seed",
        "0",
        "--batch-size",
        "200",
        "--warmup-batches",
        "3",
        "--measured-batches",
        "4",
        "--output",
        "tmp/result.json",
      ]),
    ).toEqual({
      seed: 0,
      batchSize: 200,
      warmupBatches: 3,
      measuredBatches: 4,
      output: "tmp/result.json",
    });
  });

  it.each([
    { name: "unknown", arguments_: ["--other", "1"] },
    { name: "duplicate", arguments_: ["--seed", "1", "--seed", "2"] },
    { name: "missing at end", arguments_: ["--seed"] },
    { name: "missing before flag", arguments_: ["--seed", "--batch-size", "1"] },
    { name: "fractional", arguments_: ["--seed", "1.5"] },
    { name: "negative", arguments_: ["--seed", "-1"] },
    { name: "positive sign", arguments_: ["--seed", "+1"] },
    { name: "leading whitespace", arguments_: ["--seed", " 1"] },
    { name: "trailing whitespace", arguments_: ["--seed", "1 "] },
    { name: "partially numeric", arguments_: ["--seed", "1x"] },
    { name: "unsafe integer", arguments_: ["--seed", "9007199254740992"] },
    { name: "leading zero", arguments_: ["--seed", "01"] },
  ])("rejects an invalid CLI value: $name", ({ arguments_ }) => {
    expect(() => parseBenchmarkOptions(arguments_)).toThrow(BenchmarkConfigurationError);
  });

  it.each([
    ["--seed", "4294967296"],
    ["--batch-size", "0"],
    ["--batch-size", "10001"],
    ["--warmup-batches", "0"],
    ["--warmup-batches", "21"],
    ["--measured-batches", "0"],
    ["--measured-batches", "101"],
  ])("rejects %s outside its approved bound", (flag, value) => {
    expect(() => parseBenchmarkOptions([flag, value])).toThrow(BenchmarkConfigurationError);
  });

  it.each(["", " result.json", "result.json ", "result.txt"])(
    "rejects an invalid output path %j",
    (output) => {
      expect(() => parseBenchmarkOptions(["--output", output])).toThrow(
        BenchmarkConfigurationError,
      );
    },
  );

  it("rejects more than 100000 measured rows", () => {
    expect(() =>
      parseBenchmarkOptions(["--batch-size", "10000", "--measured-batches", "11"]),
    ).toThrow("Measured repository rows must not exceed 100000.");
  });

  it("rejects more than 20000 warm-up rows", () => {
    expect(() => parseBenchmarkOptions(["--batch-size", "10000", "--warmup-batches", "3"])).toThrow(
      "Warm-up repository rows must not exceed 20000.",
    );
  });

  it("accepts the exact combined row limits", () => {
    const options = parseBenchmarkOptions([
      "--batch-size",
      "1000",
      "--warmup-batches",
      "20",
      "--measured-batches",
      "100",
    ]);
    expect(options.batchSize * options.warmupBatches).toBe(20_000);
    expect(options.batchSize * options.measuredBatches).toBe(100_000);
  });
});

describe("deterministic workload", () => {
  it("produces identical representative input for the same seed", () => {
    const first = createDeterministicWorkload(3, 7, REFERENCE_TIME_MS);
    const second = createDeterministicWorkload(3, 7, REFERENCE_TIME_MS);

    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
    expect(first[0]).toEqual({
      timestamp: "2026-08-10T11:02:08.468Z",
      level: "debug",
      service: "auth",
      message: "benchmark event 0 for auth",
      attributes: {
        request_id: "request-7-0",
        retries: 4,
        enabled: true,
      },
    });
  });

  it("changes when the seed changes", () => {
    expect(createDeterministicWorkload(3, 7, REFERENCE_TIME_MS)).not.toEqual(
      createDeterministicWorkload(3, 8, REFERENCE_TIME_MS),
    );
  });

  it.each([0, -1, 100_001, 1.5])("rejects an invalid workload count: %s", (count) => {
    expect(() => createDeterministicWorkload(count, 1, REFERENCE_TIME_MS)).toThrow(
      BenchmarkConfigurationError,
    );
  });

  it.each([-1, 4_294_967_296, 1.5])("rejects an invalid workload seed: %s", (seed) => {
    expect(() => createDeterministicWorkload(1, seed, REFERENCE_TIME_MS)).toThrow(
      BenchmarkConfigurationError,
    );
  });

  it("creates repeatable, unique UUID-v4-shaped identifiers", () => {
    const first = createDeterministicLogId(0, 0);
    const second = createDeterministicLogId(0, 1);
    expect(first).toBe("00000000-0000-4000-8000-000000000001");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(second).not.toBe(first);
  });

  it.each([
    [-1, 0],
    [4_294_967_296, 0],
    [0, -1],
    [0, 1_000_000_000_000],
  ])("rejects invalid UUID inputs", (seed, index) => {
    expect(() => createDeterministicLogId(seed, index)).toThrow(BenchmarkConfigurationError);
  });
});

describe("Git source-state reporting", () => {
  it("reports a clean working tree without claiming Task 4.3 is uncommitted", () => {
    expect(describeGitSourceState("")).toEqual({
      workingTreeDirty: false,
      task43PathsUncommitted: false,
      sourceState: "Working tree is clean at the reported base commit.",
    });
  });

  it("detects uncommitted Task 4.3 paths", () => {
    expect(
      describeGitSourceState(" M package.json\n?? tools/benchmark/ingestion-benchmark.ts\n"),
    ).toEqual({
      workingTreeDirty: true,
      task43PathsUncommitted: true,
      sourceState: "Task 4.3 benchmark paths have uncommitted changes.",
    });
  });

  it("distinguishes unrelated uncommitted changes", () => {
    expect(describeGitSourceState(" M README.md\n")).toEqual({
      workingTreeDirty: true,
      task43PathsUncommitted: false,
      sourceState: "Working tree has uncommitted changes outside Task 4.3 benchmark paths.",
    });
  });

  it("recognizes a Task 4.3 rename destination", () => {
    expect(describeGitSourceState("R  old-package.json -> package.json\n")).toMatchObject({
      workingTreeDirty: true,
      task43PathsUncommitted: true,
    });
  });
});

describe("cleanup error precedence", () => {
  it("preserves an existing primary error when close also fails", async () => {
    const primaryError = new Error("primary");
    const safeCleanupError = new Error("safe cleanup");

    const observed = await closePreservingPrimaryError(
      async () => {
        await Promise.resolve();
        throw new Error("raw close detail");
      },
      primaryError,
      safeCleanupError,
    );

    expect(observed).toBe(primaryError);
  });

  it("returns the safe cleanup error when close is the only failure", async () => {
    const safeCleanupError = new Error("safe cleanup");

    const observed = await closePreservingPrimaryError(
      async () => {
        await Promise.resolve();
        throw new Error("raw close detail");
      },
      undefined,
      safeCleanupError,
    );

    expect(observed).toBe(safeCleanupError);
  });

  it("leaves an existing result unchanged after successful close", async () => {
    const primaryError = new Error("primary");
    await expect(
      closePreservingPrimaryError(async () => Promise.resolve(), primaryError, new Error("safe")),
    ).resolves.toBe(primaryError);
  });
});

describe("stage measurements", () => {
  it("measures validation with a controlled clock and preserves operation count", () => {
    const inputs = createDeterministicWorkload(2, 7, REFERENCE_TIME_MS);
    const result = measureValidation(inputs, REFERENCE_TIME_MS, fakeClock(10, 12));

    expect(result.operationCount).toBe(2);
    expect(result.durationMs).toBe(2);
    expect(result.throughputPerSecond).toBe(1_000);
    expect(result.checksum).toMatch(/^[0-9a-f]{8}$/u);
    expect(result).toMatchObject({
      operationCount: 2,
      durationMs: 2,
      throughputPerSecond: 1_000,
    });
    expect(result.values).toHaveLength(2);
  });

  it("fails rather than measuring rejected validation input", () => {
    expect(() => measureValidation([null], REFERENCE_TIME_MS, fakeClock(1))).toThrow(
      BenchmarkVerificationError,
    );
  });

  it("measures normalization with a controlled clock and stringifies scalar attributes", () => {
    const validation = measureValidation(
      createDeterministicWorkload(2, 7, REFERENCE_TIME_MS),
      REFERENCE_TIME_MS,
      fakeClock(1, 2),
    );
    const result = measureNormalization(validation.values, fakeClock(20, 24));

    expect(result.operationCount).toBe(2);
    expect(result.durationMs).toBe(4);
    expect(result.throughputPerSecond).toBe(500);
    expect(result.checksum).toMatch(/^[0-9a-f]{8}$/u);
    expect(result).toMatchObject({
      operationCount: 2,
      durationMs: 4,
      throughputPerSecond: 500,
    });
    expect(typeof result.values[0]?.["retries"]).toBe("string");
  });

  it("independently verifies all approved scalar representations", () => {
    const entries = normalizationEntries();
    const measured = measureNormalization(entries, fakeClock(20, 21));

    expect(measured.values[0]).toEqual(
      normalizedAttributes({
        text: "unchanged",
        yes: "true",
        no: "false",
        integer: "42",
        fraction: "1.25",
        exponent: "1e+21",
        negativeZero: "0",
      }),
    );
    expect(() => {
      verifyNormalizationResult(entries, measured.values, measured.checksum);
    }).not.toThrow();
  });

  it("fails normalization verification on a count mismatch", () => {
    const entries = normalizationEntries();
    const measured = measureNormalization(entries, fakeClock(20, 21));

    expectStableNormalizationFailure(() => {
      verifyNormalizationResult(entries, [], measured.checksum);
    });
  });

  it("fails normalization verification on a missing key", () => {
    const entries = normalizationEntries();
    const measured = measureNormalization(entries, fakeClock(20, 21));
    const missingKey = normalizedAttributes({
      yes: "true",
      no: "false",
      integer: "42",
      fraction: "1.25",
      exponent: "1e+21",
      negativeZero: "0",
    });

    expectStableNormalizationFailure(() => {
      verifyNormalizationResult(entries, [missingKey], measured.checksum);
    });
  });

  it("fails normalization verification on an extra key", () => {
    const entries = normalizationEntries();
    const measured = measureNormalization(entries, fakeClock(20, 21));
    const extraKey = normalizedAttributes({
      ...(measured.values[0] ?? {}),
      unexpected: "value",
    });

    expectStableNormalizationFailure(() => {
      verifyNormalizationResult(entries, [extraKey], measured.checksum);
    });
  });

  it("fails normalization verification on an incorrect value", () => {
    const entries = normalizationEntries();
    const measured = measureNormalization(entries, fakeClock(20, 21));
    const incorrectValue = normalizedAttributes({
      ...(measured.values[0] ?? {}),
      negativeZero: "-0",
    });

    expectStableNormalizationFailure(() => {
      verifyNormalizationResult(entries, [incorrectValue], measured.checksum);
    });
  });

  it("fails normalization verification on a checksum mismatch", () => {
    const entries = normalizationEntries();
    const measured = measureNormalization(entries, fakeClock(20, 21));

    expectStableNormalizationFailure(() => {
      verifyNormalizationResult(entries, measured.values, "00000000");
    });
  });

  it("reports explicit count and row-reconciliation mismatches", () => {
    expect(() => {
      assertExpectedCount("Test", 2, 1);
    }).toThrow("Test count mismatch");
    expect(() => {
      assertRowReconciliation(10, 9);
    }).toThrow("Repository row reconciliation count mismatch");
  });
});

describe("nearest-rank repository statistics", () => {
  it.each([
    { samples: [7], percentile: 95, expected: 7 },
    { samples: [4, 1, 3, 2], percentile: 50, expected: 2 },
    { samples: [5, 1, 9], percentile: 50, expected: 5 },
    { samples: [1, 2, 3, 4], percentile: 25, expected: 1 },
    { samples: [1, 2, 3, 4], percentile: 100, expected: 4 },
  ])("selects $expected from $samples at p$percentile", ({ samples, percentile, expected }) => {
    expect(nearestRank(samples, percentile)).toBe(expected);
  });

  it("selects the maximum for p95 and p99 with ten samples", () => {
    const samples = [10, 2, 4, 1, 8, 5, 3, 9, 6, 7];
    expect(nearestRank(samples, 95)).toBe(10);
    expect(nearestRank(samples, 99)).toBe(10);
  });

  it.each([
    [[], 50],
    [[1], 0],
    [[1], 101],
    [[1, Number.NaN], 50],
    [[1, -1], 50],
  ] as const)("rejects invalid percentile input", (samples, percentile) => {
    expect(() => nearestRank(samples, percentile)).toThrow(BenchmarkVerificationError);
  });

  it("summarizes batch timings without interpolating percentiles", () => {
    expect(summarizeRepositorySamples([4, 1, 3, 2], 100)).toEqual({
      batchCount: 4,
      batchSize: 100,
      operationCount: 400,
      samplesMs: [4, 1, 3, 2],
      totalDurationMs: 10,
      throughputPerSecond: 40_000,
      batchLatencyP50Ms: 2,
      batchLatencyP95Ms: 4,
      batchLatencyP99Ms: 4,
    });
  });

  it("fails when repository samples are empty", () => {
    expect(() => summarizeRepositorySamples([], 100)).toThrow(BenchmarkVerificationError);
  });
});

describe("report primitives", () => {
  it("captures all reported process-memory fields", () => {
    expect(
      captureMemorySnapshot(() => ({
        rss: 10,
        heapTotal: 20,
        heapUsed: 15,
        external: 5,
        arrayBuffers: 2,
      })),
    ).toEqual({
      rssBytes: 10,
      heapTotalBytes: 20,
      heapUsedBytes: 15,
      externalBytes: 5,
      arrayBuffersBytes: 2,
    });
  });

  it("serializes deterministic indented JSON with a final newline", () => {
    const serialized = serializeBenchmarkReport(exampleReport());
    expect(serialized.endsWith("\n")).toBe(true);
    expect(JSON.parse(serialized)).toEqual(exampleReport());
  });

  it("refuses to serialize a report containing a PostgreSQL URL", () => {
    const report = exampleReport();
    const unsafe = {
      ...report,
      limitations: ["postgresql://user:password@localhost/database"],
    };
    expect(() => serializeBenchmarkReport(unsafe)).toThrow(BenchmarkVerificationError);
  });
});

describe("CLI module lifecycle", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  });

  it("imports without starting Docker, executing the benchmark, or writing a report", async () => {
    const spawn = vi.fn();
    const writeFile = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return { ...actual, writeFile };
    });

    const runner = await import("../../tools/benchmark/run-ingestion-microbenchmark.js");

    expect(typeof runner.runIngestionMicrobenchmark).toBe("function");
    expect(spawn).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();

    const runnerPath = resolve("tools/benchmark/run-ingestion-microbenchmark.ts");
    expect(runner.isDirectEsmEntry(pathToFileURL(runnerPath).href, runnerPath)).toBe(true);
    expect(runner.isDirectEsmEntry(pathToFileURL(runnerPath).href, undefined)).toBe(false);
    expect(runner.isDirectEsmEntry(pathToFileURL(runnerPath).href, resolve("package.json"))).toBe(
      false,
    );
  });
});
