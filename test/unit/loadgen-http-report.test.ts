import { mkdtemp, readFile, readdir, rename, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCommandRunner, SafeCommandError } from "../../tools/loadgen/commands.js";
import { requestJson } from "../../tools/loadgen/http.js";
import {
  publishReportAtomically,
  serializeReport,
  type ReportFileSystem,
} from "../../tools/loadgen/report.js";
import type { LoadGeneratorReport } from "../../tools/loadgen/types.js";

const temporaryDirectories: string[] = [];

function report(): LoadGeneratorReport {
  return {
    schemaVersion: 1,
    outcome: "failed",
    failureReasons: ["bounded synthetic failure"],
    generatedAtUtc: "2026-08-12T12:00:00.000Z",
    source: { branch: "perf/load-generator", commit: "abc", dirty: true },
    configuration: { baseUrl: "http://127.0.0.1:8080" },
    workload: { seed: 42 },
    environment: { nodeVersion: "v24" },
    resourceControls: null,
    resourceUsage: null,
    warmup: null,
    aggregationWarmup: null,
    measuredIngestion: null,
    aggregation: null,
    freshness: null,
    reconciliation: null,
    cleanup: {
      attempted: true,
      composeDownSucceeded: true,
      remainingContainers: [],
      remainingNetworks: [],
      remainingVolumes: [],
      passed: true,
      error: null,
    },
    limitations: ["smoke only"],
    unverifiedRequirements: ["PERF-001"],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("shell-disabled command execution", () => {
  it("passes shell metacharacters as one inert argument", async () => {
    const result = await createCommandRunner()({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", "& echo not-a-command"],
      timeoutMs: 5_000,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "& echo not-a-command", stderr: "" });
  });

  it("bounds child-process output capture", async () => {
    await expect(
      createCommandRunner()({
        command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1))"],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(SafeCommandError);
  });
});

describe("bounded and redacted HTTP behavior", () => {
  it("classifies transport failures without exposing the thrown message", async () => {
    let now = 0;
    const result = await requestJson(
      { url: new URL("http://127.0.0.1:8080/health"), method: "GET", timeoutMs: 1_000 },
      {
        fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("postgresql://secret")),
        clock: { now: () => now++ },
        setTimeout: (() => 1) as unknown as typeof setTimeout,
        clearTimeout: vi.fn(),
      },
    );
    expect(result.outcome).toEqual({ kind: "transport" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("classifies a successful status with malformed JSON as invalid response", async () => {
    const result = await requestJson(
      { url: new URL("http://127.0.0.1:8080/logs"), method: "GET", timeoutMs: 1_000 },
      {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("not-json", { status: 200 })),
        clock: { now: () => 1 },
        setTimeout: (() => 1) as unknown as typeof setTimeout,
        clearTimeout: vi.fn(),
      },
    );
    expect(result.outcome).toEqual({ kind: "invalid-response", status: 200 });
  });

  it("classifies a request aborted by its injected timeout", async () => {
    let callback: (() => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      callback?.();
      return Promise.reject(new Error(init?.signal?.aborted === true ? "aborted" : "unexpected"));
    });
    const result = await requestJson(
      { url: new URL("http://127.0.0.1:8080/logs"), method: "GET", timeoutMs: 1_000 },
      {
        fetch: fetchMock,
        clock: { now: () => 1 },
        setTimeout: ((handler: () => void) => {
          callback = handler;
          return 1;
        }) as unknown as typeof setTimeout,
        clearTimeout: vi.fn(),
      },
    );
    expect(result.outcome).toEqual({ kind: "timeout" });
  });

  it("does not dispatch an externally aborted request as ordinary traffic", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      return Promise.reject(new Error(init?.signal?.aborted === true ? "aborted" : "unexpected"));
    });
    const result = await requestJson(
      {
        url: new URL("http://127.0.0.1:8080/logs"),
        method: "GET",
        timeoutMs: 1_000,
        externalSignal: controller.signal,
      },
      {
        fetch: fetchMock,
        clock: { now: () => 1 },
        setTimeout: (() => 1) as unknown as typeof setTimeout,
        clearTimeout: vi.fn(),
      },
    );
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(result.outcome).toEqual({ kind: "transport" });
  });
});

describe("atomic and redacted report publication", () => {
  it("publishes indented JSON through a temporary file and atomic rename", async () => {
    const directory = await mkdtemp(join(tmpdir(), "logstream-loadgen-report-"));
    temporaryDirectories.push(directory);
    const output = join(directory, "report.json");
    await publishReportAtomically(output, report());
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(report());
    expect(await readdir(directory)).toEqual(["report.json"]);
  });

  it("removes the temporary file when publication fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "logstream-loadgen-report-failure-"));
    temporaryDirectories.push(directory);
    const remove = vi.fn<typeof rm>(rm);
    const failingWrite = vi.fn<typeof writeFile>().mockRejectedValue(new Error("write failed"));
    const fileSystem: ReportFileSystem = {
      mkdir,
      writeFile: failingWrite,
      rename,
      rm: remove,
    };
    await expect(
      publishReportAtomically(join(directory, "report.json"), report(), fileSystem),
    ).rejects.toThrow("write failed");
    expect(remove).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/u), { force: true });
  });

  it("refuses to serialize credentials or database URLs", () => {
    const unsafe = { ...report(), failureReasons: ["postgresql://user:secret@host/database"] };
    expect(() => serializeReport(unsafe)).toThrow("potentially sensitive");
    expect(serializeReport(report())).toMatch(/"schemaVersion": 1/u);
  });
});
