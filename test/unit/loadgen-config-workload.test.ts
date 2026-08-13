import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createComposeProjectName,
  createRunId,
  LoadGeneratorConfigurationError,
  parseLoadGeneratorOptions,
  resolveRunConfiguration,
} from "../../tools/loadgen/config.js";
import { createWorkloadBatch, generateLog } from "../../tools/loadgen/workload.js";

const REFERENCE = "2026-08-12T12:34:56.789Z";
const REFERENCE_MS = Date.parse(REFERENCE);

describe("load-generator strict configuration", () => {
  it("parses a deterministic million-row-capable configuration", () => {
    const options = parseLoadGeneratorOptions([
      "--measured-rows",
      "1000000",
      "--warmup-rows",
      "1000",
      "--batch-size",
      "5000",
      "--concurrency",
      "8",
      "--seed",
      "42",
      "--output",
      "result.json",
      "--request-timeout-ms",
      "10000",
      "--reference-time",
      REFERENCE,
    ]);

    expect(options).toMatchObject({
      measuredRows: 1_000_000,
      warmupRows: 1_000,
      batchSize: 5_000,
      concurrency: 8,
      seed: 42,
      outputPath: resolve("result.json"),
      requestTimeoutMs: 10_000,
      referenceTimeUtc: REFERENCE,
      baseUrl: "http://127.0.0.1:8080",
    });
  });

  it.each([
    ["unknown", ["--unknown", "1"]],
    ["duplicate", ["--seed", "1", "--seed", "2"]],
    ["missing", ["--seed"]],
    ["partial numeric", ["--seed", "10abc"]],
    ["unsafe integer", ["--measured-rows", "9007199254740992"]],
    ["out of range", ["--concurrency", "0"]],
    ["invalid calendar time", ["--reference-time", "2026-02-30T00:00:00Z"]],
    ["credential URL", ["--base-url", "http://user:token@127.0.0.1:8080"]],
    ["wrong port", ["--base-url", "http://127.0.0.1:8081"]],
  ])("rejects %s options", (_label, arguments_) => {
    expect(() => parseLoadGeneratorOptions(arguments_)).toThrow(LoadGeneratorConfigurationError);
  });

  it("creates validated deterministic run identities and a sanitized reproduction command", () => {
    expect(createRunId(42, REFERENCE)).toBe("lg-v1-0000002a-20260812t123456789z");
    expect(createComposeProjectName(new Date(REFERENCE), 123, "abcdef")).toBe(
      "logstream-loadgen-20260812123456-123-abcdef",
    );
    const options = parseLoadGeneratorOptions(["--reference-time", REFERENCE]);
    const resolved = resolveRunConfiguration(options, {
      now: () => new Date(REFERENCE),
      processId: 123,
      suffix: "abcdef",
    });
    expect(resolved.reproductionCommand).toContain("--reference-time");
    expect(resolved.reproductionCommand.join(" ")).not.toMatch(/password|postgresql:\/\//iu);
  });
});

describe("deterministic realistic workload", () => {
  it("is independent of batching and completion order", () => {
    const direct = Array.from({ length: 7 }, (_, ordinal) =>
      generateLog(42, REFERENCE_MS, "lg-v1-0000002a-20260812t123456789z", "measured", ordinal),
    );
    const batched = [0, 1, 2].flatMap(
      (batchIndex) =>
        createWorkloadBatch({
          seed: 42,
          referenceTimeMs: REFERENCE_MS,
          runId: "lg-v1-0000002a-20260812t123456789z",
          phase: "measured",
          totalRows: 7,
          batchSize: 3,
          batchIndex,
        }).logs,
    );
    expect(batched).toEqual(direct);
    expect(batched).toHaveLength(7);
  });

  it("creates valid payloads, safe markers, scalar attributes, and a final partial batch", () => {
    const batch = createWorkloadBatch({
      seed: 9,
      referenceTimeMs: REFERENCE_MS,
      runId: "lg-v1-00000009-20260812t123456789z",
      phase: "warmup",
      totalRows: 5,
      batchSize: 3,
      batchIndex: 1,
    });
    expect(batch.logs).toHaveLength(2);
    for (const log of batch.logs) {
      const timestamp = Date.parse(log.timestamp);
      expect(timestamp).toBeLessThanOrEqual(REFERENCE_MS);
      expect(timestamp).toBeGreaterThanOrEqual(REFERENCE_MS - 28 * 24 * 60 * 60 * 1_000);
      expect(["debug", "info", "warn", "error"]).toContain(log.level);
      expect(log.service.length).toBeGreaterThan(0);
      expect(log.message.length).toBeGreaterThan(0);
      expect(log.attributes).toMatchObject({
        loadgen_run_id: "lg-v1-00000009-20260812t123456789z",
        loadgen_phase: "warmup",
      });
      expect(typeof log.attributes.attempt).toBe("number");
      expect(typeof log.attributes.cached).toBe("boolean");
    }
  });
});
