import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const POSTGRES_IMAGE = "postgres:16.14-bookworm";
const ADMIN_PASSWORD = "integration_superuser_password";
const OWNER_PASSWORD = "integration_owner_password";
const RUNTIME_PASSWORD = "integration_runtime_password";
const containerName = `logstream-migration-test-${String(process.pid)}-${Date.now().toString(36)}`;

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCommand(
  command: string,
  arguments_: readonly string[],
  options: { readonly inheritOutput?: boolean; readonly environment?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      env: options.environment ?? process.env,
      shell: false,
      stdio: options.inheritOutput ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

async function requireSuccessfulCommand(
  command: string,
  arguments_: readonly string[],
): Promise<CommandResult> {
  const result = await runCommand(command, arguments_);
  if (result.exitCode !== 0) {
    throw new Error(`${command} command failed with exit code ${String(result.exitCode)}.`);
  }
  return result;
}

async function getPublishedPort(): Promise<number> {
  const result = await requireSuccessfulCommand("docker", ["port", containerName, "5432/tcp"]);
  const match = /:(\d+)\s*$/u.exec(result.stdout.trim());
  const port = Number(match?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Docker did not report a valid PostgreSQL test port.");
  }
  return port;
}

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      try {
        await client.end();
      } catch {
        // The next bounded attempt creates a fresh client.
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
    }
  }
  throw new Error("Disposable PostgreSQL did not become ready before the test deadline.");
}

async function bootstrapRoles(adminConnectionString: string): Promise<void> {
  const client = new Client({ connectionString: adminConnectionString });
  await client.connect();
  try {
    await client.query(`
CREATE ROLE logstream_owner
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  PASSWORD '${OWNER_PASSWORD}';
CREATE ROLE logstream_runtime
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  PASSWORD '${RUNTIME_PASSWORD}';
ALTER ROLE logstream_owner SET timezone TO 'UTC';
ALTER ROLE logstream_runtime SET timezone TO 'UTC';
`);
  } finally {
    await client.end();
  }
}

async function main(): Promise<number> {
  await requireSuccessfulCommand("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--publish",
    "127.0.0.1::5432",
    "--cpus",
    "1.0",
    "--memory",
    "1g",
    "--env",
    `POSTGRES_PASSWORD=${ADMIN_PASSWORD}`,
    "--env",
    "POSTGRES_DB=postgres",
    POSTGRES_IMAGE,
  ]);

  const port = await getPublishedPort();
  const adminConnectionString = `postgresql://postgres:${ADMIN_PASSWORD}@127.0.0.1:${String(port)}/postgres`;
  await waitForPostgres(adminConnectionString);
  await bootstrapRoles(adminConnectionString);

  const testEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    TEST_ADMIN_DATABASE_URL: adminConnectionString,
    TEST_OWNER_DATABASE_URL: `postgresql://logstream_owner:${OWNER_PASSWORD}@127.0.0.1:${String(port)}/postgres`,
    TEST_RUNTIME_DATABASE_URL: `postgresql://logstream_runtime:${RUNTIME_PASSWORD}@127.0.0.1:${String(port)}/postgres`,
  };
  const vitestProgram = fileURLToPath(
    new URL("../../node_modules/vitest/vitest.mjs", import.meta.url),
  );
  const testSelection = process.argv.includes("--all") ? [] : ["test/integration"];
  const result = await runCommand(process.execPath, [vitestProgram, "run", ...testSelection], {
    environment: testEnvironment,
    inheritOutput: true,
  });
  return result.exitCode;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown integration harness failure.";
  process.stderr.write(`${message}\n`);
} finally {
  if (!/^logstream-migration-test-[0-9]+-[a-z0-9]+$/u.test(containerName)) {
    process.stderr.write("Refusing to remove an unexpected container name.\n");
    exitCode = 1;
  } else {
    const cleanup = await runCommand("docker", ["rm", "--force", containerName]);
    if (cleanup.exitCode !== 0 && !cleanup.stderr.includes("No such container")) {
      process.stderr.write("Disposable PostgreSQL cleanup failed.\n");
      exitCode = 1;
    }
  }
}

process.exitCode = exitCode;
