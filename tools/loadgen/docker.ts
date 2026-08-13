import { createServer } from "node:net";

import { assertValidComposeProjectName } from "./config.js";
import { requireSuccessfulCommand, SafeCommandError } from "./commands.js";
import type {
  CleanupVerification,
  CommandRunner,
  ContainerControls,
  ResourceSample,
  Sleep,
} from "./types.js";

const EXPECTED_CONTROLS = {
  app: { nanoCpus: 500_000_000, memoryBytes: 268_435_456 },
  postgres: { nanoCpus: 1_000_000_000, memoryBytes: 1_073_741_824 },
} as const;

export interface ComposeContainers {
  readonly app: string;
  readonly postgres: string;
}

export async function assertPort8080Available(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", () => {
      reject(new SafeCommandError("Required host port 8080 is unavailable."));
    });
    server.listen({ host: "127.0.0.1", port: 8080, exclusive: true }, () => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  });
}

export function composeInvocation(
  project: string,
  args: readonly string[],
  timeoutMs: number,
): { readonly command: "docker"; readonly args: readonly string[]; readonly timeoutMs: number } {
  assertValidComposeProjectName(project);
  return { command: "docker", args: ["compose", "-p", project, ...args], timeoutMs };
}

export async function startCompose(runner: CommandRunner, project: string): Promise<void> {
  await requireSuccessfulCommand(
    runner,
    composeInvocation(project, ["up", "--build", "--detach"], 180_000),
    "The isolated Compose stack failed to start.",
  );
}

export async function waitForHealth(input: {
  readonly fetch: typeof fetch;
  readonly sleep: Sleep;
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? 60_000);
  while (Date.now() < deadline && input.signal?.aborted !== true) {
    try {
      const response = await input.fetch(new URL("/health", `${input.baseUrl}/`), {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // Readiness polling intentionally retries until the bounded deadline.
    }
    await input.sleep(500, input.signal);
  }
  throw new SafeCommandError("The isolated Compose application did not become healthy in time.");
}

async function oneContainerId(
  runner: CommandRunner,
  project: string,
  service: "app" | "postgres",
): Promise<string> {
  const result = await requireSuccessfulCommand(
    runner,
    composeInvocation(project, ["ps", "--quiet", service], 10_000),
    "Unable to identify an isolated Compose service container.",
  );
  const identifiers = result.stdout.split(/\r?\n/gu).filter((value) => value.length > 0);
  if (identifiers.length !== 1 || !/^[a-f0-9]{12,64}$/u.test(identifiers[0] ?? "")) {
    throw new SafeCommandError("Compose service container identity was not unique.");
  }
  return identifiers[0] ?? "";
}

export async function identifyComposeContainers(
  runner: CommandRunner,
  project: string,
): Promise<ComposeContainers> {
  return {
    app: await oneContainerId(runner, project, "app"),
    postgres: await oneContainerId(runner, project, "postgres"),
  };
}

export function parseContainerControls(json: string): ContainerControls {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SafeCommandError("Docker returned invalid resource-control inspection data.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new SafeCommandError("Docker resource-control inspection data has an invalid shape.");
  }
  const record = parsed as Record<string, unknown>;
  const nanoCpus = record["NanoCpus"];
  const memoryBytes = record["Memory"];
  if (!Number.isSafeInteger(nanoCpus) || !Number.isSafeInteger(memoryBytes)) {
    throw new SafeCommandError("Docker resource controls are missing or invalid.");
  }
  return { nanoCpus: nanoCpus as number, memoryBytes: memoryBytes as number };
}

async function inspectOneControl(
  runner: CommandRunner,
  containerId: string,
): Promise<ContainerControls> {
  const result = await requireSuccessfulCommand(
    runner,
    {
      command: "docker",
      args: ["inspect", "--format", "{{json .HostConfig}}", containerId],
      timeoutMs: 10_000,
    },
    "Docker resource controls could not be inspected.",
  );
  return parseContainerControls(result.stdout.trim());
}

export async function inspectAndVerifyControls(
  runner: CommandRunner,
  containers: ComposeContainers,
): Promise<{ readonly app: ContainerControls; readonly postgres: ContainerControls }> {
  const app = await inspectOneControl(runner, containers.app);
  const postgres = await inspectOneControl(runner, containers.postgres);
  if (
    app.nanoCpus !== EXPECTED_CONTROLS.app.nanoCpus ||
    app.memoryBytes !== EXPECTED_CONTROLS.app.memoryBytes ||
    postgres.nanoCpus !== EXPECTED_CONTROLS.postgres.nanoCpus ||
    postgres.memoryBytes !== EXPECTED_CONTROLS.postgres.memoryBytes
  ) {
    throw new SafeCommandError(
      "Effective Docker resource controls do not match the required limits.",
    );
  }
  return { app, postgres };
}

function parseBytes(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)(B|KiB|MiB|GiB)$/u.exec(value.trim());
  if (match === null) throw new SafeCommandError("Docker memory statistics use an unknown unit.");
  const amount = Number(match[1]);
  const factors: Readonly<Record<string, number>> = {
    B: 1,
    KiB: 1_024,
    MiB: 1_048_576,
    GiB: 1_073_741_824,
  };
  return Math.round(amount * (factors[match[2] ?? ""] ?? 0));
}

export function parseDockerStats(
  output: string,
  containers: ComposeContainers,
  elapsedMs: number,
): ResourceSample {
  const rows = output
    .split(/\r?\n/gu)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, string>);
  const find = (id: string): Record<string, string> => {
    const row = rows.find((candidate) => candidate["ID"]?.startsWith(id.slice(0, 12)) === true);
    if (row === undefined)
      throw new SafeCommandError("Docker statistics omitted a required container.");
    return row;
  };
  const parse = (row: Record<string, string>): { cpu: number; memory: number } => {
    const cpu = Number((row["CPUPerc"] ?? "").replace(/%$/u, ""));
    const memoryText = (row["MemUsage"] ?? "").split("/")[0] ?? "";
    if (!Number.isFinite(cpu) || cpu < 0)
      throw new SafeCommandError("Docker CPU statistics are invalid.");
    return { cpu, memory: parseBytes(memoryText) };
  };
  const app = parse(find(containers.app));
  const postgres = parse(find(containers.postgres));
  return {
    elapsedMs,
    appCpuPercent: app.cpu,
    appMemoryBytes: app.memory,
    postgresCpuPercent: postgres.cpu,
    postgresMemoryBytes: postgres.memory,
  };
}

export async function sampleDockerStats(
  runner: CommandRunner,
  containers: ComposeContainers,
  elapsedMs: number,
): Promise<ResourceSample> {
  const result = await requireSuccessfulCommand(
    runner,
    {
      command: "docker",
      args: ["stats", "--no-stream", "--format", "{{json .}}", containers.app, containers.postgres],
      timeoutMs: 10_000,
    },
    "Docker resource sampling failed.",
  );
  return parseDockerStats(result.stdout, containers, elapsedMs);
}

async function listProjectResources(
  runner: CommandRunner,
  object: "container" | "network" | "volume",
  project: string,
): Promise<readonly string[]> {
  const objectArgs =
    object === "container" ? ["ps", "--all", "--quiet"] : [object, "ls", "--quiet"];
  const result = await requireSuccessfulCommand(
    runner,
    {
      command: "docker",
      args: [...objectArgs, "--filter", `label=com.docker.compose.project=${project}`],
      timeoutMs: 10_000,
    },
    "Docker cleanup verification failed.",
  );
  return result.stdout.split(/\r?\n/gu).filter((value) => value.length > 0);
}

export async function cleanupCompose(
  runner: CommandRunner,
  project: string,
): Promise<CleanupVerification> {
  let composeDownSucceeded = false;
  let error: string | null = null;
  try {
    const result = await runner(
      composeInvocation(
        project,
        ["down", "--volumes", "--remove-orphans", "--timeout", "15"],
        60_000,
      ),
    );
    composeDownSucceeded = result.exitCode === 0;
    if (!composeDownSucceeded) error = "Isolated Compose cleanup returned a failure status.";
  } catch {
    error = "Isolated Compose cleanup did not complete.";
  }
  let remainingContainers: readonly string[] = [];
  let remainingNetworks: readonly string[] = [];
  let remainingVolumes: readonly string[] = [];
  try {
    remainingContainers = await listProjectResources(runner, "container", project);
    remainingNetworks = await listProjectResources(runner, "network", project);
    remainingVolumes = await listProjectResources(runner, "volume", project);
  } catch {
    error ??= "Exact-project cleanup verification failed.";
  }
  const passed =
    composeDownSucceeded &&
    remainingContainers.length === 0 &&
    remainingNetworks.length === 0 &&
    remainingVolumes.length === 0 &&
    error === null;
  return {
    attempted: true,
    composeDownSucceeded,
    remainingContainers,
    remainingNetworks,
    remainingVolumes,
    passed,
    error,
  };
}

export const REQUIRED_DOCKER_CONTROLS = EXPECTED_CONTROLS;
