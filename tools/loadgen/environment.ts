import { cpus, freemem, hostname, platform, release, totalmem } from "node:os";

import { requireSuccessfulCommand } from "./commands.js";
import { composeInvocation } from "./docker.js";
import type { CommandRunner } from "./types.js";

async function version(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  safeFailure: string,
): Promise<string> {
  const result = await requireSuccessfulCommand(
    runner,
    { command, args, timeoutMs: 10_000 },
    safeFailure,
  );
  return result.stdout.trim();
}

export async function captureEnvironment(
  runner: CommandRunner,
  composeProject: string,
): Promise<Readonly<Record<string, unknown>>> {
  const npmExecutable = process.env["npm_execpath"];
  if (npmExecutable === undefined || npmExecutable.length === 0) {
    throw new Error("Unable to locate the npm executable for version capture.");
  }
  const [npmVersion, dockerVersion, composeVersion, postgresVersion] = await Promise.all([
    version(
      runner,
      process.execPath,
      [npmExecutable, "--version"],
      "Unable to record the npm version.",
    ),
    version(runner, "docker", ["--version"], "Unable to record the Docker version."),
    version(
      runner,
      "docker",
      ["compose", "version"],
      "Unable to record the Docker Compose version.",
    ),
    requireSuccessfulCommand(
      runner,
      composeInvocation(
        composeProject,
        ["exec", "--no-TTY", "postgres", "postgres", "--version"],
        10_000,
      ),
      "Unable to record the PostgreSQL version.",
    ).then((result) => result.stdout.trim()),
  ]);
  const cpuList = cpus();
  return {
    nodeVersion: process.version,
    npmVersion,
    platform: platform(),
    release: release(),
    architecture: process.arch,
    hostName: hostname(),
    cpuModel: cpuList[0]?.model ?? "unknown",
    logicalCpuCount: cpuList.length,
    hostMemoryBytes: totalmem(),
    hostFreeMemoryAtCaptureBytes: freemem(),
    dockerVersion,
    composeVersion,
    postgresVersion,
  };
}

export async function captureGitSource(
  runner: CommandRunner,
): Promise<Readonly<Record<string, unknown>>> {
  const [branch, commit, status] = await Promise.all([
    version(runner, "git", ["branch", "--show-current"], "Unable to record the Git branch."),
    version(runner, "git", ["rev-parse", "HEAD"], "Unable to record the Git commit."),
    requireSuccessfulCommand(
      runner,
      { command: "git", args: ["status", "--porcelain"], timeoutMs: 10_000 },
      "Unable to record the Git working-tree state.",
    ).then((result) => result.stdout),
  ]);
  const dirty = status.trim().length > 0;
  return {
    branch,
    commit,
    dirty,
    sourceState: dirty
      ? "The working tree contains uncommitted changes."
      : "Working tree is clean at the reported commit.",
  };
}
