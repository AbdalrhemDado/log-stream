import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ComposeContractError,
  runComposeContract,
  validateContractEnvironment,
  validateProjectName,
  type CommandRequest,
  type CommandResult,
  type ComposeContractDependencies,
} from "../harness/run-compose-contract.js";

const REPOSITORY_ROOT = resolve("C:/contract-repository");
const NOW = 1_700_000_000_000;

interface HarnessOverrides {
  readonly arguments?: readonly string[];
  readonly portAvailable?: boolean;
  readonly command?: (request: CommandRequest, index: number) => Promise<CommandResult>;
  readonly fetch?: typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function createFetch(): typeof fetch {
  return vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    if (url.endsWith("/health")) {
      return Promise.resolve(new Response("healthy", { status: 200 }));
    }
    if (init?.method === "POST") {
      return Promise.resolve(jsonResponse({ accepted: 1, rejected: [] }));
    }
    const service = new URL(url).searchParams.get("service") ?? "";
    const runId = service.replace(/-restart-marker$/u, "");
    return Promise.resolve(
      jsonResponse({
        logs: [
          {
            service,
            message: `${runId}-persistent-message`,
          },
        ],
        next_cursor: null,
      }),
    );
  });
}

async function execute(overrides: HarnessOverrides = {}): Promise<{
  readonly commands: CommandRequest[];
  readonly fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
}> {
  const commands: CommandRequest[] = [];
  const fetchMock = (overrides.fetch ?? createFetch()) as ReturnType<typeof vi.fn<typeof fetch>>;
  const dependencies: ComposeContractDependencies = {
    runCommand: (request) => {
      commands.push(request);
      return (
        overrides.command?.(request, commands.length - 1) ??
        Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      );
    },
    isPortAvailable: () => Promise.resolve(overrides.portAvailable ?? true),
    fetch: fetchMock,
    now: () => NOW,
    delay: () => Promise.resolve(),
  };
  await runComposeContract(
    {
      arguments: overrides.arguments ?? [],
      repositoryRoot: REPOSITORY_ROOT,
      processId: 42,
      environment: { PATH: "safe-path" },
      executablePath: "node",
    },
    dependencies,
  );
  return { commands, fetchMock };
}

function composeOperations(commands: readonly CommandRequest[]): readonly CommandRequest[] {
  return commands.filter(
    (command) => command.command === "docker" && command.arguments[0] === "compose",
  );
}

describe("Compose contract harness", () => {
  it("is import-safe under isolated module loading without subprocess or port-probe effects", async () => {
    const spawn = vi.fn();
    const createServer = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const originalExitCode = process.exitCode;
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ spawn }));
    vi.doMock("node:net", () => ({ createServer }));

    try {
      const isolatedModule = await import("../harness/run-compose-contract.js");
      expect(isolatedModule.isDirectEsmEntry(import.meta.url, undefined)).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
      expect(createServer).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(originalExitCode);
    } finally {
      vi.doUnmock("node:child_process");
      vi.doUnmock("node:net");
      fetchSpy.mockRestore();
      vi.resetModules();
    }
  });

  it("uses shell-disabled child execution and explicit Compose identity", async () => {
    const { commands } = await execute();
    const compose = composeOperations(commands);
    const composeFile = resolve(REPOSITORY_ROOT, "docker-compose.yml");

    expect(compose.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.shell).toBe(false);
      expect(command.cwd).toBe(REPOSITORY_ROOT);
    }
    for (const command of compose) {
      expect(command.arguments).toEqual(
        expect.arrayContaining([
          "--file",
          composeFile,
          "--project-directory",
          REPOSITORY_ROOT,
          "--project-name",
          "logstream-contract-42-loyw3v28",
        ]),
      );
    }
  });

  it("strictly validates project and contract environment values without coercion", () => {
    const coercion = vi.fn(() => "logstream-contract-42-loyw3v28");
    const forged = { [Symbol.toPrimitive]: coercion };

    expect(validateProjectName("logstream-contract-42-loyw3v28")).toBe(
      "logstream-contract-42-loyw3v28",
    );
    expect(() => validateProjectName(forged)).toThrow("Contract runner configuration is invalid.");
    expect(coercion).not.toHaveBeenCalled();
    expect(() =>
      validateContractEnvironment({
        CONTRACT_BASE_URL: "http://127.0.0.1:8080",
        CONTRACT_RUN_ID: "contract-42-loyw3v28",
      }),
    ).not.toThrow();
    expect(() =>
      validateContractEnvironment({
        CONTRACT_BASE_URL: "http://sentinel.invalid",
        CONTRACT_RUN_ID: "contract-42-loyw3v28",
      }),
    ).toThrow("Contract runner configuration is invalid.");
  });

  it.each([
    {
      CONTRACT_BASE_URL: "http://submitted-url-sentinel.invalid",
      CONTRACT_RUN_ID: "contract-42-loyw3v28",
    },
    {
      CONTRACT_BASE_URL: "http://127.0.0.1:8080",
      CONTRACT_RUN_ID: "submitted-run-id-sentinel",
    },
  ])("does not reflect malformed contract environment sentinels", (environment) => {
    let error: unknown;
    try {
      validateContractEnvironment(environment);
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ComposeContractError);
    expect((error as Error).message).toBe("Contract runner configuration is invalid.");
    expect((error as Error).message).not.toContain("submitted-url-sentinel");
    expect((error as Error).message).not.toContain("submitted-run-id-sentinel");
  });

  it.each([[["--unknown-sentinel"]], [["--unknown-sentinel", "submitted-secret"]]])(
    "rejects CLI input without reflecting it: %j",
    async (arguments_: string[]) => {
      let error: unknown;
      try {
        await execute({ arguments: arguments_ });
      } catch (caught: unknown) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ComposeContractError);
      expect((error as Error).message).toBe(
        "Contract runner does not accept command-line arguments.",
      );
      expect((error as Error).message).not.toContain("unknown-sentinel");
      expect((error as Error).message).not.toContain("submitted-secret");
    },
  );

  it("stops on an occupied port before starting Compose", async () => {
    const commands: CommandRequest[] = [];
    await expect(
      runComposeContract(
        {
          arguments: [],
          repositoryRoot: REPOSITORY_ROOT,
          processId: 42,
          environment: {},
          executablePath: "node",
        },
        {
          runCommand: (request) => {
            commands.push(request);
            return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
          },
          isPortAvailable: () => Promise.resolve(false),
          fetch: createFetch(),
          now: () => NOW,
          delay: () => Promise.resolve(),
        },
      ),
    ).rejects.toThrow("Contract HTTP port is already occupied.");
    expect(commands).toEqual([]);
  });

  it("attempts exact-project cleanup after partial startup failure and preserves the primary error", async () => {
    let cleanupAttempted = false;
    const sentinel = "docker-secret-output";
    let error: unknown;
    try {
      await execute({
        command: (request) => {
          if (request.arguments.includes("up")) {
            return Promise.resolve({ exitCode: 1, stdout: sentinel, stderr: sentinel });
          }
          if (request.arguments.includes("down")) {
            cleanupAttempted = true;
            return Promise.resolve({ exitCode: 1, stdout: sentinel, stderr: sentinel });
          }
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        },
      });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(cleanupAttempted).toBe(true);
    expect((error as Error).message).toBe("Contract Compose startup failed.");
    expect((error as Error).message).not.toContain(sentinel);
  });

  it("fails when final cleanup is the only failure and redacts child output", async () => {
    const sentinel = "postgresql://credential-sentinel";
    let error: unknown;
    try {
      await execute({
        command: (request) =>
          request.arguments.includes("--volumes")
            ? Promise.resolve({ exitCode: 1, stdout: sentinel, stderr: sentinel })
            : Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
      });
    } catch (caught: unknown) {
      error = caught;
    }
    expect((error as Error).message).toBe("Contract Compose cleanup failed.");
    expect((error as Error).message).not.toContain(sentinel);
  });

  it("captures Docker output while only focused Vitest inherits output", async () => {
    const { commands } = await execute();
    const vitest = commands.find((command) => command.command === "node");
    const docker = commands.filter((command) => command.command === "docker");

    expect(vitest?.inheritOutput).toBe(true);
    expect(vitest?.arguments).toContain("test/contract/public-api.contract.test.ts");
    expect(docker.every((command) => !command.inheritOutput)).toBe(true);
  });

  it("preserves the named volume during restart and removes it during final cleanup", async () => {
    const { commands } = await execute();
    const downs = composeOperations(commands).filter((command) =>
      command.arguments.includes("down"),
    );

    expect(downs).toHaveLength(2);
    expect(downs[0]?.arguments).not.toContain("--volumes");
    expect(downs[0]?.arguments).toContain("--remove-orphans");
    expect(downs[1]?.arguments).toContain("--volumes");
    expect(downs[1]?.arguments).toContain("--remove-orphans");
  });

  it("uses bounded public HTTP for marker creation, initial verification, and post-restart verification", async () => {
    const { fetchMock } = await execute();
    const markerRequests = fetchMock.mock.calls.filter(([input]) =>
      requestUrl(input).includes("contract-42-loyw3v28-restart-marker"),
    );
    const postRequest = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");

    expect(postRequest?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(markerRequests).toHaveLength(2);
    expect(markerRequests.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });

  it("inspects only resources carrying the exact validated project label", async () => {
    const { commands } = await execute();
    const inspections = commands.filter(
      (command) =>
        command.command === "docker" &&
        ["ps", "network", "volume"].includes(command.arguments[0] ?? ""),
    );

    expect(inspections).toHaveLength(3);
    for (const command of inspections) {
      expect(command.arguments).toContain(
        "label=com.docker.compose.project=logstream-contract-42-loyw3v28",
      );
      expect(command.arguments.join(" ")).not.toContain("prune");
    }
  });

  it("refuses success when an exact-project resource remains", async () => {
    await expect(
      execute({
        command: (request) =>
          request.arguments[0] === "ps"
            ? Promise.resolve({ exitCode: 0, stdout: "remaining-resource", stderr: "" })
            : Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow("Contract Compose cleanup could not be verified.");
  });

  it("translates a thrown raw child error without exposing it", async () => {
    let error: unknown;
    try {
      await execute({
        command: () => Promise.reject(new Error("raw-child-password-sentinel")),
      });
    } catch (caught: unknown) {
      error = caught;
    }
    expect((error as Error).message).toBe("Contract Compose startup failed.");
    expect((error as Error).message).not.toContain("raw-child-password-sentinel");
  });
});
