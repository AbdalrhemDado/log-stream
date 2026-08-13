import { spawn } from "node:child_process";

import type { CommandInvocation, CommandResult, CommandRunner } from "./types.js";

const MAX_CAPTURED_OUTPUT_BYTES = 2 * 1024 * 1024;

export class SafeCommandError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SafeCommandError";
  }
}

export function createCommandRunner(): CommandRunner {
  return async (invocation: CommandInvocation): Promise<CommandResult> =>
    new Promise((resolve, reject) => {
      if (
        invocation.command.length === 0 ||
        invocation.command.includes("\u0000") ||
        invocation.args.some((argument) => argument.includes("\u0000"))
      ) {
        reject(new SafeCommandError("Command invocation contains an invalid argument."));
        return;
      }
      const child = spawn(invocation.command, [...invocation.args], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let capturedBytes = 0;
      let timedOut = false;
      let outputExceeded = false;
      let settled = false;
      const timers: {
        timeout?: ReturnType<typeof setTimeout>;
        hardStop?: ReturnType<typeof setTimeout>;
        outputHardStop?: ReturnType<typeof setTimeout>;
      } = {};
      const finishWithError = (error: SafeCommandError): void => {
        if (settled) return;
        settled = true;
        if (timers.timeout !== undefined) clearTimeout(timers.timeout);
        if (timers.hardStop !== undefined) clearTimeout(timers.hardStop);
        if (timers.outputHardStop !== undefined) clearTimeout(timers.outputHardStop);
        reject(error);
      };
      const capture = (target: Buffer[], chunk: Buffer): void => {
        if (outputExceeded) return;
        capturedBytes += chunk.length;
        if (capturedBytes > MAX_CAPTURED_OUTPUT_BYTES) {
          outputExceeded = true;
          child.kill();
          timers.outputHardStop = setTimeout(() => {
            child.kill("SIGKILL");
            child.stdin.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
            finishWithError(
              new SafeCommandError("A required local command produced excessive output."),
            );
          }, 5_000);
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        capture(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        capture(stderr, chunk);
      });
      child.once("error", () => {
        finishWithError(new SafeCommandError("A required local command failed to start."));
      });
      timers.timeout = setTimeout(() => {
        if (outputExceeded) return;
        timedOut = true;
        child.kill();
        timers.hardStop = setTimeout(() => {
          child.kill("SIGKILL");
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          finishWithError(
            new SafeCommandError("A required local command exceeded its time limit."),
          );
        }, 5_000);
      }, invocation.timeoutMs);
      child.once("close", (code) => {
        if (timers.timeout !== undefined) clearTimeout(timers.timeout);
        if (settled) return;
        settled = true;
        if (timers.hardStop !== undefined) clearTimeout(timers.hardStop);
        if (timers.outputHardStop !== undefined) clearTimeout(timers.outputHardStop);
        if (timedOut) {
          reject(new SafeCommandError("A required local command exceeded its time limit."));
          return;
        }
        if (outputExceeded) {
          reject(new SafeCommandError("A required local command produced excessive output."));
          return;
        }
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
      if (invocation.stdin === undefined) child.stdin.end();
      else child.stdin.end(invocation.stdin, "utf8");
    });
}

export async function requireSuccessfulCommand(
  runner: CommandRunner,
  invocation: CommandInvocation,
  safeFailureMessage: string,
): Promise<CommandResult> {
  const result = await runner(invocation);
  if (result.exitCode !== 0) throw new SafeCommandError(safeFailureMessage);
  return result;
}
