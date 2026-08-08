import { buildApp } from "./app.js";
import { loadConfig } from "./config/app-config.js";
import { loadDatabaseConfig } from "./database/database-config.js";
import { createDatabasePool, probeDatabase } from "./database/database-pool.js";
import { waitForDatabase } from "./database/wait-for-database.js";
import {
  installServerLifecycle,
  ShutdownTimeoutError,
  type ShutdownSignalSource,
} from "./server-lifecycle.js";
import { buildLoggerOptions } from "./shared/logging.js";
import { createReadiness } from "./shared/readiness.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const databaseConfig = loadDatabaseConfig(process.env);
  const readiness = createReadiness();
  const databasePool = createDatabasePool(databaseConfig);
  const app = buildApp({
    logger: buildLoggerOptions(config),
    readiness,
    databaseProbe: async () => probeDatabase(databasePool),
  });
  databasePool.on("error", () => {
    readiness.markUnavailable();
    app.log.error({ failureType: "idle-client" }, "Database pool connection lost");
  });
  const signalSource: ShutdownSignalSource = {
    on: (signal, handler) => {
      process.on(signal, handler);
    },
    off: (signal, handler) => {
      process.off(signal, handler);
    },
  };
  const lifecycle = installServerLifecycle({
    signalSource,
    markNotReady: () => {
      readiness.beginShutdown();
    },
    closeApplication: async () => app.close(),
    closeDatabase: async () => databasePool.end(),
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    forceExit: (exitCode) => {
      process.exit(exitCode);
    },
    onShutdownStarted: (signal) => {
      app.log.info({ signal }, "Application shutdown started");
    },
    onShutdownFailed: (error, signal) => {
      app.log.error(
        {
          failureType: error instanceof ShutdownTimeoutError ? "deadline" : "resource-close",
          signal,
        },
        "Application shutdown failed",
      );
      process.exitCode = 1;
    },
  });

  try {
    const databaseWait = await waitForDatabase({
      probe: async () => probeDatabase(databasePool),
      timeoutMs: databaseConfig.startupTimeoutMs,
      retryDelayMs: databaseConfig.retryDelayMs,
    });
    app.log.info({ attempts: databaseWait.attempts }, "Database connection established");

    await app.listen({
      host: config.host,
      port: config.port,
    });
    readiness.markReady();
  } catch (error: unknown) {
    lifecycle.dispose();
    readiness.beginShutdown();
    await Promise.allSettled([app.close(), databasePool.end()]);
    throw error;
  }
}

void main().catch(() => {
  process.stderr.write("Server startup failed.\n");
  process.exitCode = 1;
});
