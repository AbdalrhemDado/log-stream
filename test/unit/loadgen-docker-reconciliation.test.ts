import { describe, expect, it } from "vitest";

import {
  cleanupCompose,
  composeInvocation,
  inspectAndVerifyControls,
  parseContainerControls,
  parseDockerStats,
} from "../../tools/loadgen/docker.js";
import {
  buildReconciliationInvocation,
  reconcileRows,
} from "../../tools/loadgen/reconciliation.js";
import type { CommandInvocation, CommandResult, CommandRunner } from "../../tools/loadgen/types.js";

const PROJECT = "logstream-loadgen-20260812120000-1-abcdef";
const CONTAINERS = { app: "a".repeat(64), postgres: "b".repeat(64) };

function queueRunner(results: readonly CommandResult[], calls: CommandInvocation[]): CommandRunner {
  const queue = [...results];
  return (invocation) => {
    calls.push(invocation);
    const result = queue.shift();
    if (result === undefined) throw new Error("unexpected command");
    return Promise.resolve(result);
  };
}

describe("safe Docker command construction and resource evidence", () => {
  it("uses shell-free argument arrays scoped to an exact validated Compose project", () => {
    expect(composeInvocation(PROJECT, ["up", "--detach"], 1_000)).toEqual({
      command: "docker",
      args: ["compose", "-p", PROJECT, "up", "--detach"],
      timeoutMs: 1_000,
    });
    expect(() => composeInvocation("../unsafe", ["down"], 1_000)).toThrow();
  });

  it("parses and enforces exact effective CPU and memory controls", async () => {
    expect(parseContainerControls('{"NanoCpus":500000000,"Memory":268435456}')).toEqual({
      nanoCpus: 500_000_000,
      memoryBytes: 268_435_456,
    });
    const calls: CommandInvocation[] = [];
    const passing = queueRunner(
      [
        { exitCode: 0, stdout: '{"NanoCpus":500000000,"Memory":268435456}\n', stderr: "" },
        { exitCode: 0, stdout: '{"NanoCpus":1000000000,"Memory":1073741824}\n', stderr: "" },
      ],
      calls,
    );
    await expect(inspectAndVerifyControls(passing, CONTAINERS)).resolves.toBeDefined();
    expect(calls.every((call) => call.command === "docker")).toBe(true);

    const failing = queueRunner(
      [
        { exitCode: 0, stdout: '{"NanoCpus":0,"Memory":268435456}\n', stderr: "" },
        { exitCode: 0, stdout: '{"NanoCpus":1000000000,"Memory":1073741824}\n', stderr: "" },
      ],
      [],
    );
    await expect(inspectAndVerifyControls(failing, CONTAINERS)).rejects.toThrow(
      "do not match the required limits",
    );
  });

  it("parses bounded Docker CPU and memory samples", () => {
    const output = [
      JSON.stringify({ ID: "a".repeat(12), CPUPerc: "49.50%", MemUsage: "128MiB / 256MiB" }),
      JSON.stringify({ ID: "b".repeat(12), CPUPerc: "91.25%", MemUsage: "512MiB / 1GiB" }),
    ].join("\n");
    expect(parseDockerStats(output, CONTAINERS, 1_000)).toEqual({
      elapsedMs: 1_000,
      appCpuPercent: 49.5,
      appMemoryBytes: 134_217_728,
      postgresCpuPercent: 91.25,
      postgresMemoryBytes: 536_870_912,
    });
  });

  it("verifies exact-project cleanup on normal and failing down paths", async () => {
    const successCalls: CommandInvocation[] = [];
    const success = await cleanupCompose(
      queueRunner(
        Array.from({ length: 4 }, () => ({ exitCode: 0, stdout: "", stderr: "" })),
        successCalls,
      ),
      PROJECT,
    );
    expect(success.passed).toBe(true);
    expect(successCalls[0]?.args).toEqual([
      "compose",
      "-p",
      PROJECT,
      "down",
      "--volumes",
      "--remove-orphans",
      "--timeout",
      "15",
    ]);

    const failure = await cleanupCompose(
      queueRunner(
        [
          { exitCode: 1, stdout: "", stderr: "hostile details" },
          { exitCode: 0, stdout: "remaining-container\n", stderr: "" },
          { exitCode: 0, stdout: "", stderr: "" },
          { exitCode: 0, stdout: "", stderr: "" },
        ],
        [],
      ),
      PROJECT,
    );
    expect(failure).toMatchObject({
      passed: false,
      composeDownSucceeded: false,
      remainingContainers: ["remaining-container"],
    });
    expect(failure.error).not.toContain("hostile");
  });
});

describe("PostgreSQL row reconciliation", () => {
  it("uses fixed SQL through stdin and a validated psql variable argument", () => {
    const runId = "lg-v1-0000002a-20260812t120000000z";
    const invocation = buildReconciliationInvocation(PROJECT, runId);
    expect(invocation.command).toBe("docker");
    expect(invocation.args).toContain(`run_id=${runId}`);
    expect(invocation.stdin).toContain(":'run_id'");
    expect(invocation.stdin).not.toContain(runId);
    expect(() => buildReconciliationInvocation(PROJECT, "x' OR true --")).toThrow();
  });

  it("reports exact match and mismatch without rewriting counters", () => {
    expect(reconcileRows(0, 1_000, 1_000)).toEqual({
      preExistingRows: 0,
      expectedRows: 1_000,
      observedRows: 1_000,
      delta: 0,
      passed: true,
    });
    expect(reconcileRows(0, 1_000, 1_003)).toMatchObject({ delta: 3, passed: false });
    expect(reconcileRows(1, 1_000, 1_000)).toMatchObject({ passed: false });
  });
});
