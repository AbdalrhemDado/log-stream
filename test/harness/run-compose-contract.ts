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
const UNAVAILABLE_PROBE_ATTEMPTS = 8;
const SHUTDOWN_BATCHES = 6;
const SHUTDOWN_BATCH_SIZE = 10;
const APP_CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/u;
const BODY_SENTINEL = "contract-body-secret-sentinel";
const SQL_TEXT = "'); DROP TABLE logstream.logs; --";
const SQL_FILTER = "' OR TRUE --";
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
  interruption: "Contract database interruption verification failed.",
  interruptionHealth: "Contract database interruption health verification failed.",
  interruptionPost: "Contract database interruption ingestion verification failed.",
  interruptionList: "Contract database interruption list verification failed.",
  interruptionAggregation: "Contract database interruption aggregation verification failed.",
  interruptionRecovery: "Contract database interruption recovery verification failed.",
  startupFailure: "Contract database startup-failure verification failed.",
  shutdown: "Contract graceful shutdown verification failed.",
  redaction: "Contract application-log redaction verification failed.",
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
  errorMessage: string = ERRORS.readiness,
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
  throw new ComposeContractError(errorMessage);
}

async function fetchOutcome(
  dependencies: ComposeContractDependencies,
  input: string,
  init: RequestInit = {},
): Promise<Response | undefined> {
  try {
    return await dependencies.fetch(input, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
}

async function readJsonRecord(
  response: Response,
  errorMessage: string,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ComposeContractError(errorMessage);
  }
  if (!isRecord(body)) {
    throw new ComposeContractError(errorMessage);
  }
  return body;
}

async function requireTransientFailure(
  response: Response | undefined,
  errorMessage: string = ERRORS.interruption,
): Promise<void> {
  if (response === undefined) {
    return;
  }
  const body = await readJsonRecord(response, errorMessage);
  const retryAfter = response.headers.get("retry-after");
  if (
    response.status !== 503 ||
    retryAfter !== "30" ||
    Object.keys(body).length !== 1 ||
    body["error"] !== "Service temporarily unavailable." ||
    Object.hasOwn(body, "accepted") ||
    Object.hasOwn(body, "rejected")
  ) {
    const bodyKeys = Object.keys(body);
    const safeBodyKeys = bodyKeys.every((key) => /^[a-z_]{1,50}$/u.test(key))
      ? bodyKeys.sort().join(",") || "none"
      : "unsafe";
    const retryAfterClassification =
      retryAfter === "30" ? "expected" : retryAfter === null ? "missing" : "unexpected";
    const errorClassification =
      body["error"] === "Service temporarily unavailable."
        ? "expected"
        : typeof body["error"] === "string"
          ? "unexpected-string"
          : Object.hasOwn(body, "error")
            ? "unexpected-type"
            : "missing";

    throw new ComposeContractError(
      `${errorMessage} Observed response: status=${String(response.status)}; retry-after=${retryAfterClassification}; body-keys=${safeBodyKeys}; error-field=${errorClassification}.`,
    );
  }
}

async function requireUnavailableHealth(
  dependencies: ComposeContractDependencies,
  attempts = UNAVAILABLE_PROBE_ATTEMPTS,
  errorMessage: string = ERRORS.interruption,
): Promise<void> {
  let unavailableObserved = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetchOutcome(dependencies, `${CONTRACT_BASE_URL}/health`);
    if (response?.status === 200) {
      throw new ComposeContractError(errorMessage);
    }
    if (response === undefined || response.status === 503) {
      unavailableObserved = true;
    }
    await dependencies.delay(RETRY_DELAY_MS);
  }
  if (!unavailableObserved) {
    throw new ComposeContractError(errorMessage);
  }
}

async function requireMarkerAbsent(
  dependencies: ComposeContractDependencies,
  service: string,
): Promise<void> {
  const response = await boundedFetch(
    dependencies,
    `${CONTRACT_BASE_URL}/logs?service=${encodeURIComponent(service)}&limit=1000`,
  );
  const body = await readJsonRecord(response, ERRORS.interruption);
  if (response.status !== 200 || !Array.isArray(body["logs"]) || body["logs"].length !== 0) {
    throw new ComposeContractError(ERRORS.interruption);
  }
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

async function createAndVerifyCanary(
  dependencies: ComposeContractDependencies,
  runId: string,
  phase: string,
): Promise<void> {
  const service = `${runId}-${phase}-canary`;
  const message = `${runId}-${phase}-message`;
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
        },
      ],
    }),
  });
  const body = await readJsonRecord(response, ERRORS.interruption);
  if (
    response.status !== 200 ||
    body["accepted"] !== 1 ||
    !Array.isArray(body["rejected"]) ||
    body["rejected"].length !== 0
  ) {
    throw new ComposeContractError(ERRORS.interruption);
  }
  await verifyMarker(dependencies, CONTRACT_BASE_URL, service, message);
}

function requireSafeCapturedLogs(logs: string, runId: string): void {
  const normalized = logs.toLowerCase();
  const submittedSentinels = [
    `${BODY_SENTINEL}-${runId}`,
    SQL_TEXT,
    SQL_FILTER,
    `${runId}-interruption-failed-marker`,
  ];
  const encodedSentinels = submittedSentinels.flatMap((value) => {
    const plusEncoded = new URLSearchParams({ value }).toString().slice("value=".length);
    return [encodeURIComponent(value), plusEncoded, plusEncoded.replaceAll("+", "%20")];
  });
  const forbidden = [
    "local_runtime_password",
    "local_owner_password",
    "local_superuser_password",
    "postgresql://",
    "postgres://",
    "migration_database_url=",
    "database_url=",
    ...submittedSentinels,
    ...encodedSentinels,
    "sqlstate",
    "postgresql detail:",
    "postgresql hint:",
    "postgresql context:",
  ];
  if (
    forbidden.some((value) => normalized.includes(value.toLowerCase())) ||
    /\b(?:select|insert|update|delete|drop|alter|create|truncate)\b[^\r\n]*(?:contract-|logstream\.logs|interruption-failed-marker)/iu.test(
      logs,
    ) ||
    /\n\s*at\s+(?:async\s+)?[^\n]+\([^\n]+:\d+:\d+\)/u.test(logs) ||
    /[a-z]:\\users\\[^\s]+/iu.test(logs)
  ) {
    throw new ComposeContractError(ERRORS.redaction);
  }
}

async function runDatabaseInterruption(
  dependencies: ComposeContractDependencies,
  composePrefix: readonly string[],
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  runId: string,
): Promise<void> {
  await requireCommand(
    dependencies,
    createCommand("docker", [...composePrefix, "stop", "postgres"], repositoryRoot, environment),
    ERRORS.interruption,
  );
  await requireUnavailableHealth(
    dependencies,
    UNAVAILABLE_PROBE_ATTEMPTS,
    ERRORS.interruptionHealth,
  );

  const service = `${runId}-interruption-failed-marker`;
  const timestamp = new Date(dependencies.now()).toISOString();
  const post = await fetchOutcome(dependencies, `${CONTRACT_BASE_URL}/logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      logs: [{ timestamp, level: "info", service, message: "must-not-be-accepted" }],
    }),
  });
  await requireTransientFailure(post, ERRORS.interruptionPost);
  await requireTransientFailure(
    await fetchOutcome(
      dependencies,
      `${CONTRACT_BASE_URL}/logs?service=${encodeURIComponent(service)}`,
    ),
    ERRORS.interruptionList,
  );
  const since = new Date(dependencies.now() - 60_000).toISOString();
  const until = new Date(dependencies.now() + 60_000).toISOString();
  await requireTransientFailure(
    await fetchOutcome(
      dependencies,
      `${CONTRACT_BASE_URL}/logs/aggregate?${new URLSearchParams({ since, until, bucket: "1m", service }).toString()}`,
    ),
    ERRORS.interruptionAggregation,
  );

  await requireCommand(
    dependencies,
    createCommand("docker", [...composePrefix, "start", "postgres"], repositoryRoot, environment),
    ERRORS.interruption,
  );
  try {
    await waitForHealth(dependencies, CONTRACT_BASE_URL);
    await requireMarkerAbsent(dependencies, service);
    await createAndVerifyCanary(dependencies, runId, "interruption-recovery");
  } catch {
    throw new ComposeContractError(ERRORS.interruptionRecovery);
  }
}

async function runStartupFailure(
  dependencies: ComposeContractDependencies,
  composePrefix: readonly string[],
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  runId: string,
): Promise<void> {
  for (const service of ["app", "postgres"]) {
    await requireCommand(
      dependencies,
      createCommand("docker", [...composePrefix, "stop", service], repositoryRoot, environment),
      ERRORS.startupFailure,
    );
  }
  await requireCommand(
    dependencies,
    createCommand(
      "docker",
      [...composePrefix, "up", "--detach", "--no-deps", "app"],
      repositoryRoot,
      environment,
    ),
    ERRORS.startupFailure,
  );
  const container = await requireCommand(
    dependencies,
    createCommand(
      "docker",
      [...composePrefix, "ps", "--all", "--quiet", "app"],
      repositoryRoot,
      environment,
    ),
    ERRORS.startupFailure,
  );
  const containerId = container.stdout.trim();
  if (!APP_CONTAINER_ID_PATTERN.test(containerId)) {
    throw new ComposeContractError(ERRORS.startupFailure);
  }
  let failedSafely = false;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const result = await requireCommand(
      dependencies,
      createCommand(
        "docker",
        ["inspect", "--format", "{{json .State}}", containerId],
        repositoryRoot,
        environment,
      ),
      ERRORS.startupFailure,
    );
    let state: unknown;
    try {
      state = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new ComposeContractError(ERRORS.startupFailure);
    }
    if (!isRecord(state)) {
      throw new ComposeContractError(ERRORS.startupFailure);
    }
    if (state["Running"] === false) {
      if (
        state["OOMKilled"] !== false ||
        !Number.isSafeInteger(state["ExitCode"]) ||
        state["ExitCode"] === 0
      ) {
        throw new ComposeContractError(ERRORS.startupFailure);
      }
      failedSafely = true;
      break;
    }
    await dependencies.delay(RETRY_DELAY_MS);
  }
  if (!failedSafely) {
    throw new ComposeContractError(ERRORS.startupFailure);
  }
  await requireUnavailableHealth(dependencies, 1, ERRORS.startupFailure);
  const logs = await requireCommand(
    dependencies,
    createCommand(
      "docker",
      [...composePrefix, "logs", "--no-color", "app"],
      repositoryRoot,
      environment,
    ),
    ERRORS.startupFailure,
  );
  requireSafeCapturedLogs(`${logs.stdout}\n${logs.stderr}`, runId);

  await requireCommand(
    dependencies,
    createCommand("docker", [...composePrefix, "start", "postgres"], repositoryRoot, environment),
    ERRORS.startupFailure,
  );
  await requireCommand(
    dependencies,
    createCommand(
      "docker",
      [...composePrefix, "up", "--detach", "--force-recreate", "app"],
      repositoryRoot,
      environment,
    ),
    ERRORS.startupFailure,
  );
  await waitForHealth(dependencies, CONTRACT_BASE_URL, ERRORS.startupFailure);
  await createAndVerifyCanary(dependencies, runId, "startup-recovery");
}

interface ShutdownWaveResult {
  readonly acceptedMessages: readonly string[];
}

async function classifyShutdownWave(
  outcomes: readonly PromiseSettledResult<Response | undefined>[],
  messagesByBatch: readonly (readonly string[])[],
): Promise<ShutdownWaveResult> {
  const acceptedMessages: string[] = [];
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "rejected" || outcome.value === undefined) {
      continue;
    }
    const response = outcome.value;
    if (response.status === 503) {
      await requireTransientFailure(response);
      continue;
    }
    if (response.status !== 200) {
      throw new ComposeContractError(ERRORS.shutdown);
    }
    const body = await readJsonRecord(response, ERRORS.shutdown);
    const messages = messagesByBatch[index];
    if (
      messages === undefined ||
      body["accepted"] !== messages.length ||
      !Array.isArray(body["rejected"]) ||
      body["rejected"].length !== 0
    ) {
      throw new ComposeContractError(ERRORS.shutdown);
    }
    acceptedMessages.push(...messages);
  }
  return { acceptedMessages };
}

async function waitForStoppedContainer(
  dependencies: ComposeContractDependencies,
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  containerId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await requireCommand(
      dependencies,
      createCommand(
        "docker",
        ["inspect", "--format", "{{json .State}}", containerId],
        repositoryRoot,
        environment,
      ),
      ERRORS.shutdown,
    );
    let state: unknown;
    try {
      state = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new ComposeContractError(ERRORS.shutdown);
    }
    if (!isRecord(state)) {
      throw new ComposeContractError(ERRORS.shutdown);
    }
    if (state["Running"] === false) {
      if (state["OOMKilled"] !== false || state["ExitCode"] !== 0) {
        throw new ComposeContractError(ERRORS.shutdown);
      }
      return;
    }
    await dependencies.delay(RETRY_DELAY_MS);
  }
  throw new ComposeContractError(ERRORS.shutdown);
}

async function reconcileShutdownRows(
  dependencies: ComposeContractDependencies,
  service: string,
  expectedMessages: readonly string[],
): Promise<void> {
  const response = await boundedFetch(
    dependencies,
    `${CONTRACT_BASE_URL}/logs?service=${encodeURIComponent(service)}&limit=1000`,
  );
  const body = await readJsonRecord(response, ERRORS.shutdown);
  if (response.status !== 200 || !Array.isArray(body["logs"])) {
    throw new ComposeContractError(ERRORS.shutdown);
  }
  const observedMessages = body["logs"].map((row) => {
    if (!isRecord(row) || typeof row["message"] !== "string") {
      throw new ComposeContractError(ERRORS.shutdown);
    }
    return row["message"];
  });
  if (
    observedMessages.length !== expectedMessages.length ||
    new Set(observedMessages).size !== observedMessages.length ||
    [...observedMessages].sort().join("\n") !== [...expectedMessages].sort().join("\n")
  ) {
    throw new ComposeContractError(ERRORS.shutdown);
  }
}

async function runGracefulShutdown(
  dependencies: ComposeContractDependencies,
  composePrefix: readonly string[],
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  runId: string,
): Promise<void> {
  const container = await requireCommand(
    dependencies,
    createCommand(
      "docker",
      [...composePrefix, "ps", "--quiet", "app"],
      repositoryRoot,
      environment,
    ),
    ERRORS.shutdown,
  );
  const containerId = container.stdout.trim();
  if (!APP_CONTAINER_ID_PATTERN.test(containerId)) {
    throw new ComposeContractError(ERRORS.shutdown);
  }

  const service = `${runId}-shutdown-wave`;
  const timestamp = new Date(dependencies.now()).toISOString();
  const messagesByBatch = Array.from({ length: SHUTDOWN_BATCHES }, (_, batchIndex) =>
    Array.from(
      { length: SHUTDOWN_BATCH_SIZE },
      (_, entryIndex) => `${runId}-shutdown-${String(batchIndex)}-${String(entryIndex)}`,
    ),
  );
  const requests = messagesByBatch.map((messages) =>
    fetchOutcome(dependencies, `${CONTRACT_BASE_URL}/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        logs: messages.map((message) => ({
          timestamp,
          level: "info",
          service,
          message,
        })),
      }),
    }),
  );
  await dependencies.delay(10);
  await requireCommand(
    dependencies,
    createCommand(
      "docker",
      [...composePrefix, "kill", "--signal", "SIGTERM", "app"],
      repositoryRoot,
      environment,
    ),
    ERRORS.shutdown,
  );
  const outcomes = await Promise.allSettled(requests);
  const wave = await classifyShutdownWave(outcomes, messagesByBatch);
  await waitForStoppedContainer(dependencies, repositoryRoot, environment, containerId);
  const health = await fetchOutcome(dependencies, `${CONTRACT_BASE_URL}/health`);
  if (health?.status === 200) {
    throw new ComposeContractError(ERRORS.shutdown);
  }

  await requireCommand(
    dependencies,
    createCommand(
      "docker",
      [...composePrefix, "up", "--detach", "app"],
      repositoryRoot,
      environment,
    ),
    ERRORS.shutdown,
  );
  await waitForHealth(dependencies, CONTRACT_BASE_URL, ERRORS.shutdown);
  await reconcileShutdownRows(dependencies, service, wave.acceptedMessages);
  await createAndVerifyCanary(dependencies, runId, "shutdown-recovery");
}

async function verifyCapturedApplicationLogs(
  dependencies: ComposeContractDependencies,
  composePrefix: readonly string[],
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  runId: string,
): Promise<void> {
  const logs = await requireCommand(
    dependencies,
    createCommand(
      "docker",
      [...composePrefix, "logs", "--no-color", "app"],
      repositoryRoot,
      environment,
    ),
    ERRORS.redaction,
  );
  requireSafeCapturedLogs(`${logs.stdout}\n${logs.stderr}`, runId);
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
        [
          vitestProgram,
          "run",
          "test/contract/public-api.contract.test.ts",
          "test/contract/failure-security.contract.test.ts",
        ],
        repositoryRoot,
        testEnvironment,
        true,
      ),
      ERRORS.contract,
    );

    await runDatabaseInterruption(
      dependencies,
      composePrefix,
      repositoryRoot,
      options.environment,
      contractEnvironment.CONTRACT_RUN_ID,
    );
    await runStartupFailure(
      dependencies,
      composePrefix,
      repositoryRoot,
      options.environment,
      contractEnvironment.CONTRACT_RUN_ID,
    );
    await runGracefulShutdown(
      dependencies,
      composePrefix,
      repositoryRoot,
      options.environment,
      contractEnvironment.CONTRACT_RUN_ID,
    );
    await verifyCapturedApplicationLogs(
      dependencies,
      composePrefix,
      repositoryRoot,
      options.environment,
      contractEnvironment.CONTRACT_RUN_ID,
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
    await waitForHealth(dependencies, CONTRACT_BASE_URL, ERRORS.persistence);
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
