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
  readonly command?: (
    request: CommandRequest,
    index: number,
    defaultResult: CommandResult,
  ) => Promise<CommandResult>;
  readonly fetch?: typeof fetch;
  readonly connectionFailureDuringInterruption?: boolean;
  readonly omitShutdownRows?: boolean;
}

interface FakeRuntimeState {
  appRunning: boolean;
  appExitCode: number;
  postgresRunning: boolean;
  readonly shutdownMessages: string[];
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

function createFetch(
  state: FakeRuntimeState,
  onRequest: (event: string) => void = () => undefined,
  behavior: {
    readonly connectionFailureDuringInterruption?: boolean;
    readonly omitShutdownRows?: boolean;
  } = {},
): typeof fetch {
  return vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    onRequest(
      `http:${init?.method ?? "GET"}:${url}${typeof init?.body === "string" ? `:${init.body}` : ""}`,
    );
    if (!state.appRunning) {
      return Promise.reject(new Error("application unavailable"));
    }
    if (url.endsWith("/health")) {
      return Promise.resolve(
        jsonResponse(
          state.postgresRunning ? { status: "ok" } : { status: "unavailable" },
          state.postgresRunning ? 200 : 503,
        ),
      );
    }
    if (!state.postgresRunning) {
      if (behavior.connectionFailureDuringInterruption === true) {
        return Promise.reject(new Error("connection interrupted"));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: "Service temporarily unavailable." }), {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "30" },
        }),
      );
    }
    if (init?.method === "POST") {
      if (typeof init.body !== "string") {
        return Promise.reject(new Error("unexpected request body"));
      }
      const parsed = JSON.parse(init.body) as {
        logs: { service: string; message: string }[];
      };
      const shutdown = parsed.logs.filter((log) => log.service.endsWith("-shutdown-wave"));
      state.shutdownMessages.push(...shutdown.map((log) => log.message));
      return Promise.resolve(jsonResponse({ accepted: parsed.logs.length, rejected: [] }));
    }
    if (url.includes("/logs/aggregate")) {
      return Promise.resolve(jsonResponse({ buckets: [] }));
    }
    const service = new URL(url).searchParams.get("service") ?? "";
    if (service.endsWith("-interruption-failed-marker")) {
      return Promise.resolve(jsonResponse({ logs: [], next_cursor: null }));
    }
    if (service.endsWith("-shutdown-wave")) {
      return Promise.resolve(
        jsonResponse({
          logs:
            behavior.omitShutdownRows === true
              ? []
              : state.shutdownMessages.map((message, index) => ({
                  id: String(index),
                  service,
                  message,
                })),
          next_cursor: null,
        }),
      );
    }
    const runId = service
      .replace(/-restart-marker$/u, "")
      .replace(/-(?:interruption-recovery|startup-recovery|shutdown-recovery)-canary$/u, "");
    const message = service.endsWith("-restart-marker")
      ? `${runId}-persistent-message`
      : `${service.replace(/-canary$/u, "")}-message`;
    return Promise.resolve(
      jsonResponse({
        logs: [
          {
            service,
            message,
          },
        ],
        next_cursor: null,
      }),
    );
  });
}

async function execute(overrides: HarnessOverrides = {}): Promise<{
  readonly commands: CommandRequest[];
  readonly events: readonly string[];
  readonly fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
}> {
  const commands: CommandRequest[] = [];
  const events: string[] = [];
  const state: FakeRuntimeState = {
    appRunning: true,
    appExitCode: 0,
    postgresRunning: true,
    shutdownMessages: [],
  };
  const fetchMock = (overrides.fetch ??
    createFetch(state, (event) => events.push(event), {
      ...(overrides.connectionFailureDuringInterruption === undefined
        ? {}
        : {
            connectionFailureDuringInterruption: overrides.connectionFailureDuringInterruption,
          }),
      ...(overrides.omitShutdownRows === undefined
        ? {}
        : { omitShutdownRows: overrides.omitShutdownRows }),
    })) as ReturnType<typeof vi.fn<typeof fetch>>;
  const dependencies: ComposeContractDependencies = {
    runCommand: (request) => {
      commands.push(request);
      events.push(`command:${request.command}:${request.arguments.join(" ")}`);
      const arguments_ = request.arguments;
      const service = arguments_.at(-1);
      if (arguments_.includes("stop") && service === "postgres") {
        state.postgresRunning = false;
      } else if (arguments_.includes("start") && service === "postgres") {
        state.postgresRunning = true;
      } else if (arguments_.includes("stop") && service === "app") {
        state.appRunning = false;
        state.appExitCode = 0;
      } else if (arguments_.includes("kill") && service === "app") {
        state.appRunning = false;
        state.appExitCode = 0;
      } else if (arguments_.includes("up") && service === "app") {
        state.appRunning = state.postgresRunning;
        state.appExitCode = state.postgresRunning ? 0 : 1;
      } else if (arguments_.includes("up") && !arguments_.includes("--no-deps")) {
        state.appRunning = true;
        state.appExitCode = 0;
        state.postgresRunning = true;
      }
      const defaultResult =
        arguments_[0] === "compose" && arguments_.includes("ps") && arguments_.includes("--quiet")
          ? { exitCode: 0, stdout: "a".repeat(64), stderr: "" }
          : request.command === "docker" && arguments_[0] === "inspect"
            ? {
                exitCode: 0,
                stdout: JSON.stringify({
                  Running: state.appRunning,
                  OOMKilled: false,
                  ExitCode: state.appExitCode,
                }),
                stderr: "",
              }
            : { exitCode: 0, stdout: "", stderr: "" };
      return (
        overrides.command?.(request, commands.length - 1, defaultResult) ??
        Promise.resolve(defaultResult)
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
  return { commands, events, fetchMock };
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
          fetch: createFetch({
            appRunning: true,
            appExitCode: 0,
            postgresRunning: true,
            shutdownMessages: [],
          }),
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
        command: (request, _index, defaultResult) => {
          if (request.arguments.includes("up")) {
            return Promise.resolve({ exitCode: 1, stdout: sentinel, stderr: sentinel });
          }
          if (request.arguments.includes("down")) {
            cleanupAttempted = true;
            return Promise.resolve({ exitCode: 1, stdout: sentinel, stderr: sentinel });
          }
          return Promise.resolve(defaultResult);
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
        command: (request, _index, defaultResult) =>
          request.arguments.includes("--volumes")
            ? Promise.resolve({ exitCode: 1, stdout: sentinel, stderr: sentinel })
            : Promise.resolve(defaultResult),
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
    expect(vitest?.arguments).toContain("test/contract/failure-security.contract.test.ts");
    expect(docker.every((command) => !command.inheritOutput)).toBe(true);
  });

  it("uses exact-project database interruption and startup recovery commands", async () => {
    const { commands, events } = await execute();
    const compose = composeOperations(commands);
    const stopPostgres = compose.find(
      (command) => command.arguments.includes("stop") && command.arguments.at(-1) === "postgres",
    );
    const noDependencyApp = compose.find(
      (command) =>
        command.arguments.includes("up") &&
        command.arguments.includes("--no-deps") &&
        command.arguments.at(-1) === "app",
    );
    const startPostgresIndex = compose.findLastIndex(
      (command) => command.arguments.includes("start") && command.arguments.at(-1) === "postgres",
    );
    const recoveredAppIndex = compose.findIndex(
      (command, index) =>
        index > startPostgresIndex &&
        command.arguments.includes("up") &&
        command.arguments.at(-1) === "app",
    );

    expect(stopPostgres).toBeDefined();
    expect(noDependencyApp).toBeDefined();
    expect(startPostgresIndex).toBeGreaterThanOrEqual(0);
    expect(recoveredAppIndex).toBeGreaterThan(startPostgresIndex);
    expect(compose[recoveredAppIndex]?.arguments).toContain("--force-recreate");
    const failedStartupIndex = events.findIndex((event) =>
      event.startsWith("command:docker:inspect --format"),
    );
    const startPostgresEventIndex = events.findIndex(
      (event, index) => index > failedStartupIndex && event.includes(" start postgres"),
    );
    expect(failedStartupIndex).toBeGreaterThanOrEqual(0);
    expect(startPostgresEventIndex).toBeGreaterThan(failedStartupIndex);
    expect(compose.map((command) => command.shell)).toEqual(compose.map(() => false));
  });

  it("issues the bounded ingestion wave before exact-app SIGTERM and reconciles after restart", async () => {
    const { commands, events } = await execute();
    const shutdownPostIndex = events.findIndex(
      (event) => event.startsWith("http:POST:") && event.includes("shutdown-wave"),
    );
    const signalIndex = events.findIndex(
      (event) => event.startsWith("command:docker:") && event.includes("kill --signal SIGTERM app"),
    );
    const signal = commands.find(
      (command) => command.arguments.includes("kill") && command.arguments.at(-1) === "app",
    );

    expect(shutdownPostIndex).toBeGreaterThanOrEqual(0);
    expect(signalIndex).toBeGreaterThan(shutdownPostIndex);
    expect(signal?.arguments).toContain("SIGTERM");
    expect(signal?.arguments).not.toContain("SIGKILL");
    expect(
      events.some(
        (event, index) => index > signalIndex && event.includes("shutdown-wave&limit=1000"),
      ),
    ).toBe(true);
  });

  it("fails if health reports ready after PostgreSQL is stopped", async () => {
    const alwaysHealthy = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/health")) {
        return Promise.resolve(jsonResponse({ status: "ok" }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ accepted: 1, rejected: [] }));
      }
      return Promise.resolve(jsonResponse({ logs: [], next_cursor: null }));
    });

    await expect(execute({ fetch: alwaysHealthy })).rejects.toThrow(
      "Contract database interruption health verification failed.",
    );
  });

  it("requires Retry-After on a transient database interruption response", async () => {
    let postgresStopped = false;
    const missingRetryAfter = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/health")) {
        return Promise.resolve(
          jsonResponse(
            postgresStopped ? { status: "unavailable" } : { status: "ok" },
            postgresStopped ? 503 : 200,
          ),
        );
      }
      if (postgresStopped) {
        return Promise.resolve(jsonResponse({ error: "Service temporarily unavailable." }, 503));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ accepted: 1, rejected: [] }));
      }
      return Promise.resolve(jsonResponse({ logs: [], next_cursor: null }));
    });

    await expect(
      execute({
        fetch: missingRetryAfter,
        command: (request, _index, defaultResult) => {
          if (request.arguments.includes("stop") && request.arguments.at(-1) === "postgres") {
            postgresStopped = true;
          }
          return Promise.resolve(defaultResult);
        },
      }),
    ).rejects.toThrow("Contract database interruption ingestion verification failed.");
  });

  it("classifies database connection interruption as unaccepted without inventing a status", async () => {
    await expect(execute({ connectionFailureDuringInterruption: true })).resolves.toBeDefined();
  });

  it("fails reconciliation when a row reported accepted is missing after shutdown restart", async () => {
    await expect(execute({ omitShutdownRows: true })).rejects.toThrow(
      "Contract graceful shutdown verification failed.",
    );
  });

  it("captures and rejects credential-bearing application logs without reflecting them", async () => {
    let error: unknown;
    try {
      await execute({
        command: (request, _index, defaultResult) =>
          request.arguments.includes("logs")
            ? Promise.resolve({
                exitCode: 0,
                stdout: "postgresql://user:local_runtime_password@database/internal",
                stderr: "",
              })
            : Promise.resolve(defaultResult),
      });
    } catch (caught: unknown) {
      error = caught;
    }
    expect((error as Error).message).toBe(
      "Contract application-log redaction verification failed.",
    );
    expect((error as Error).message).not.toContain("local_runtime_password");
  });

  it.each([
    "%27%29%3B+DROP+TABLE+logstream.logs%3B+--",
    "%27%29%3B%20DROP%20TABLE%20logstream.logs%3B%20--",
  ])(
    "rejects an encoded query sentinel in captured logs without reflecting it: %s",
    async (sentinel) => {
      let error: unknown;
      try {
        await execute({
          command: (request, _index, defaultResult) =>
            request.arguments.includes("logs")
              ? Promise.resolve({ exitCode: 0, stdout: sentinel, stderr: "" })
              : Promise.resolve(defaultResult),
        });
      } catch (caught: unknown) {
        error = caught;
      }

      expect((error as Error).message).toBe(
        "Contract application-log redaction verification failed.",
      );
      expect((error as Error).message).not.toContain(sentinel);
    },
  );

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
        command: (request, _index, defaultResult) =>
          request.arguments[0] === "ps"
            ? Promise.resolve({ exitCode: 0, stdout: "remaining-resource", stderr: "" })
            : Promise.resolve(defaultResult),
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
