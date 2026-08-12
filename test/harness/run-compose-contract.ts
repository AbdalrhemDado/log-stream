import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONTRACT_BASE_URL = "http://127.0.0.1:8080";
const CONTRACT_HOST = "127.0.0.1";
const CONTRACT_PORT = 8080;
const READINESS_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 250;
const PROJECT_NAME_PATTERN = /^logstream-contract-[0-9]+-[a-z0-9]+$/u;
const RUN_ID_PATTERN = /^contract-[0-9]+-[a-z0-9]+$/u;

const ERRORS = {
  arguments: "Contract runner does not accept command-line arguments.",
  configuration: "Contract runner configuration is invalid.",
  portOccupied: "Contract HTTP port is already occupied.",
  startup: "Contract Compose startup failed.",
  readiness: "Contract system did not become ready.",
  contract: "Public contract tests failed.",
  persistence: "Contract persistence verification failed.",
  restartStop: "Contract Compose stop failed.",
  restartStart: "Contract Compose restart failed.",
  cleanup: "Contract Compose cleanup failed.",
  inspection: "Contract Compose cleanup could not be verified.",
} as const;

export class ComposeContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ComposeContractError";
  }
}

export interface CommandRequest {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly inheritOutput: boolean;
  readonly shell: false;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ComposeContractDependencies {
  readonly runCommand: (request: CommandRequest) => Promise<CommandResult>;
  readonly isPortAvailable: (host: string, port: number) => Promise<boolean>;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly delay: (milliseconds: number) => Promise<void>;
}

export interface ComposeContractOptions {
  readonly arguments: readonly string[];
  readonly repositoryRoot: string;
  readonly processId: number;
  readonly environment: NodeJS.ProcessEnv;
  readonly executablePath: string;
}

interface ContractEnvironment {
  readonly CONTRACT_BASE_URL: typeof CONTRACT_BASE_URL;
  readonly CONTRACT_RUN_ID: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateProjectName(value: unknown): string {
  if (typeof value !== "string" || !PROJECT_NAME_PATTERN.test(value)) {
    throw new ComposeContractError(ERRORS.configuration);
  }
  return value;
}

export function validateContractEnvironment(value: unknown): ContractEnvironment {
  if (!isRecord(value)) {
    throw new ComposeContractError(ERRORS.configuration);
  }
  const baseUrl = Object.getOwnPropertyDescriptor(value, "CONTRACT_BASE_URL");
  const runId = Object.getOwnPropertyDescriptor(value, "CONTRACT_RUN_ID");
  if (
    baseUrl?.enumerable !== true ||
    !("value" in baseUrl) ||
    baseUrl.value !== CONTRACT_BASE_URL ||
    runId?.enumerable !== true ||
    !("value" in runId) ||
    typeof runId.value !== "string" ||
    !RUN_ID_PATTERN.test(runId.value)
  ) {
    throw new ComposeContractError(ERRORS.configuration);
  }
  return { CONTRACT_BASE_URL, CONTRACT_RUN_ID: runId.value };
}

function composeArguments(
  composeFile: string,
  repositoryRoot: string,
  projectName: string,
  operation: readonly string[],
): readonly string[] {
  return [
    "compose",
    "--file",
    composeFile,
    "--project-directory",
    repositoryRoot,
    "--project-name",
    projectName,
    ...operation,
  ];
}

function safeError(error: unknown, fallback: string): ComposeContractError {
  return error instanceof ComposeContractError ? error : new ComposeContractError(fallback);
}

async function requireCommand(
  dependencies: ComposeContractDependencies,
  request: CommandRequest,
  errorMessage: string,
): Promise<CommandResult> {
  let result: CommandResult;
  try {
    result = await dependencies.runCommand(request);
  } catch {
    throw new ComposeContractError(errorMessage);
  }
  if (result.exitCode !== 0) {
    throw new ComposeContractError(errorMessage);
  }
  return result;
}

function createCommand(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  inheritOutput = false,
): CommandRequest {
  return {
    command,
    arguments: arguments_,
    cwd,
    environment,
    inheritOutput,
    shell: false,
  };
}

async function boundedFetch(
  dependencies: ComposeContractDependencies,
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await dependencies.fetch(input, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ComposeContractError(ERRORS.persistence);
  }
}

async function waitForHealth(
  dependencies: ComposeContractDependencies,
  baseUrl: string,
): Promise<void> {
  const deadline = dependencies.now() + READINESS_TIMEOUT_MS;
  while (dependencies.now() < deadline) {
    try {
      const response = await dependencies.fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200) {
        return;
      }
    } catch {
      // A bounded retry uses a fresh request and signal.
    }
    await dependencies.delay(RETRY_DELAY_MS);
  }
  throw new ComposeContractError(ERRORS.readiness);
}

async function verifyMarker(
  dependencies: ComposeContractDependencies,
  baseUrl: string,
  service: string,
  message: string,
): Promise<void> {
  const response = await boundedFetch(
    dependencies,
    `${baseUrl}/logs?service=${encodeURIComponent(service)}&limit=100`,
  );
  if (response.status !== 200) {
    throw new ComposeContractError(ERRORS.persistence);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ComposeContractError(ERRORS.persistence);
  }
  if (!isRecord(body) || !Array.isArray(body["logs"])) {
    throw new ComposeContractError(ERRORS.persistence);
  }
  const found = body["logs"].some(
    (item) => isRecord(item) && item["service"] === service && item["message"] === message,
  );
  if (!found) {
    throw new ComposeContractError(ERRORS.persistence);
  }
}

async function createAndVerifyMarker(
  dependencies: ComposeContractDependencies,
  contractEnvironment: ContractEnvironment,
): Promise<void> {
  const service = `${contractEnvironment.CONTRACT_RUN_ID}-restart-marker`;
  const message = `${contractEnvironment.CONTRACT_RUN_ID}-persistent-message`;
  const response = await boundedFetch(dependencies, `${CONTRACT_BASE_URL}/logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      logs: [
        {
          timestamp: new Date(dependencies.now()).toISOString(),
          level: "info",
          service,
          message,
          attributes: { purpose: "compose-restart" },
        },
      ],
    }),
  });
  if (response.status !== 200) {
    throw new ComposeContractError(ERRORS.persistence);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ComposeContractError(ERRORS.persistence);
  }
  if (
    !isRecord(body) ||
    body["accepted"] !== 1 ||
    !Array.isArray(body["rejected"]) ||
    body["rejected"].length !== 0
  ) {
    throw new ComposeContractError(ERRORS.persistence);
  }
  await verifyMarker(dependencies, CONTRACT_BASE_URL, service, message);
}

async function inspectProjectAbsence(
  dependencies: ComposeContractDependencies,
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  projectName: string,
): Promise<void> {
  const inspections = [
    ["ps", "--all", "--filter", `label=com.docker.compose.project=${projectName}`, "--quiet"],
    ["network", "ls", "--filter", `label=com.docker.compose.project=${projectName}`, "--quiet"],
    ["volume", "ls", "--filter", `label=com.docker.compose.project=${projectName}`, "--quiet"],
  ] as const;
  for (const arguments_ of inspections) {
    const result = await requireCommand(
      dependencies,
      createCommand("docker", arguments_, repositoryRoot, environment),
      ERRORS.inspection,
    );
    if (result.stdout.trim().length !== 0) {
      throw new ComposeContractError(ERRORS.inspection);
    }
  }
}

async function cleanupProject(
  dependencies: ComposeContractDependencies,
  composePrefix: readonly string[],
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  projectName: string,
): Promise<void> {
  await requireCommand(
    dependencies,
    createCommand(
      "docker",
      [...composePrefix, "down", "--volumes", "--remove-orphans"],
      repositoryRoot,
      environment,
    ),
    ERRORS.cleanup,
  );
  await inspectProjectAbsence(dependencies, repositoryRoot, environment, projectName);
}

export async function runComposeContract(
  options: ComposeContractOptions,
  dependencies: ComposeContractDependencies,
): Promise<void> {
  if (options.arguments.length !== 0) {
    throw new ComposeContractError(ERRORS.arguments);
  }
  if (!Number.isSafeInteger(options.processId) || options.processId < 1) {
    throw new ComposeContractError(ERRORS.configuration);
  }

  const repositoryRoot = resolve(options.repositoryRoot);
  const composeFile = resolve(repositoryRoot, "docker-compose.yml");
  const projectName = validateProjectName(
    `logstream-contract-${String(options.processId)}-${dependencies.now().toString(36)}`,
  );
  const contractEnvironment = validateContractEnvironment({
    CONTRACT_BASE_URL,
    CONTRACT_RUN_ID: `contract-${String(options.processId)}-${dependencies.now().toString(36)}`,
  });
  const composePrefix = composeArguments(composeFile, repositoryRoot, projectName, []);

  if (!(await dependencies.isPortAvailable(CONTRACT_HOST, CONTRACT_PORT))) {
    throw new ComposeContractError(ERRORS.portOccupied);
  }

  let cleanupArmed = false;
  let primaryError: ComposeContractError | undefined;
  try {
    cleanupArmed = true;
    await requireCommand(
      dependencies,
      createCommand(
        "docker",
        [...composePrefix, "up", "--build", "--detach"],
        repositoryRoot,
        options.environment,
      ),
      ERRORS.startup,
    );
    await waitForHealth(dependencies, CONTRACT_BASE_URL);

    const vitestProgram = resolve(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
    const testEnvironment: NodeJS.ProcessEnv = {
      ...options.environment,
      ...contractEnvironment,
    };
    await requireCommand(
      dependencies,
      createCommand(
        options.executablePath,
        [vitestProgram, "run", "test/contract/public-api.contract.test.ts"],
        repositoryRoot,
        testEnvironment,
        true,
      ),
      ERRORS.contract,
    );

    await createAndVerifyMarker(dependencies, contractEnvironment);
    await requireCommand(
      dependencies,
      createCommand(
        "docker",
        [...composePrefix, "down", "--remove-orphans"],
        repositoryRoot,
        options.environment,
      ),
      ERRORS.restartStop,
    );
    await requireCommand(
      dependencies,
      createCommand(
        "docker",
        [...composePrefix, "up", "--detach"],
        repositoryRoot,
        options.environment,
      ),
      ERRORS.restartStart,
    );
    await waitForHealth(dependencies, CONTRACT_BASE_URL);
    await verifyMarker(
      dependencies,
      CONTRACT_BASE_URL,
      `${contractEnvironment.CONTRACT_RUN_ID}-restart-marker`,
      `${contractEnvironment.CONTRACT_RUN_ID}-persistent-message`,
    );
  } catch (error: unknown) {
    primaryError = safeError(error, ERRORS.contract);
  }

  let cleanupError: ComposeContractError | undefined;
  if (cleanupArmed) {
    try {
      await cleanupProject(
        dependencies,
        composePrefix,
        repositoryRoot,
        options.environment,
        projectName,
      );
    } catch (error: unknown) {
      cleanupError = safeError(error, ERRORS.cleanup);
    }
  }

  if (primaryError !== undefined) {
    throw primaryError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
}

export function isDirectEsmEntry(moduleUrl: string, executedPath: string | undefined): boolean {
  return executedPath !== undefined && pathToFileURL(resolve(executedPath)).href === moduleUrl;
}

function runRealCommand(request: CommandRequest): Promise<CommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(request.command, request.arguments, {
      cwd: request.cwd,
      env: request.environment,
      shell: request.shell,
      stdio: request.inheritOutput ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectCommand);
    child.on("close", (exitCode) => {
      resolveCommand({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

function probePort(host: string, port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const server = createServer();
    server.unref();
    server.once("error", () => {
      resolveProbe(false);
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => {
        resolveProbe(true);
      });
    });
  });
}

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

if (isDirectEsmEntry(import.meta.url, process.argv[1])) {
  void runComposeContract(
    {
      arguments: process.argv.slice(2),
      repositoryRoot,
      processId: process.pid,
      environment: process.env,
      executablePath: process.execPath,
    },
    {
      runCommand: runRealCommand,
      isPortAvailable: probePort,
      fetch,
      now: Date.now,
      delay: (milliseconds) =>
        new Promise((resolveDelay) => {
          setTimeout(resolveDelay, milliseconds);
        }),
    },
  )
    .then(() => {
      process.stdout.write("Public Compose contract verification passed and cleanup completed.\n");
    })
    .catch((error: unknown) => {
      const message =
        error instanceof ComposeContractError ? error.message : "Contract runner failed.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
