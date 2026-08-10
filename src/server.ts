import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import { loadConfig } from "./config/app-config.js";
import { loadDatabaseConfig } from "./database/database-config.js";
import {
  createDatabasePool,
  createMigrationOwnerConnection,
  probeDatabase,
  verifyRuntimeDatabase,
} from "./database/database-pool.js";
import { loadMigrations } from "./database/migrations/migration-loader.js";
import {
  migrateBeforeRuntime,
  runMigrationsWithOwnerRetry,
} from "./database/migrations/migration-runner.js";
import { buildPartitionPlan } from "./database/partitions/partition-plan.js";
import { preparePartitions } from "./database/partitions/partition-preparer.js";
import { waitForDatabase } from "./database/wait-for-database.js";
import {
  installServerLifecycle,
  ShutdownTimeoutError,
  type ShutdownSignalSource,
} from "./server-lifecycle.js";
import { createIngestionRepository } from "./modules/ingestion/ingestion-repository.js";
import { createIngestionService } from "./modules/ingestion/ingestion-service.js";
import { createLogQueryRepository } from "./modules/query/log-query-repository.js";
import { createLogQueryService } from "./modules/query/log-query-service.js";
import { buildLoggerOptions } from "./shared/logging.js";
import { createReadiness } from "./shared/readiness.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../migrations", import.meta.url));

async function startRuntime(
  config: ReturnType<typeof loadConfig>,
  databaseConfig: ReturnType<typeof loadDatabaseConfig>,
): Promise<void> {
  const readiness = createReadiness();
  const databasePool = createDatabasePool(databaseConfig);
  let app: ReturnType<typeof buildApp> | undefined;
  databasePool.on("error", () => {
    readiness.markUnavailable();
    if (app === undefined) {
      process.stderr.write("Runtime database connection lost during startup.\n");
      return;
    }
    app.log.error({ failureType: "idle-client" }, "Database pool connection lost");
  });

  try {
    const databaseWait = await waitForDatabase({
      probe: async () => probeDatabase(databasePool),
      timeoutMs: databaseConfig.startupTimeoutMs,
      retryDelayMs: databaseConfig.retryDelayMs,
    });
    await verifyRuntimeDatabase(databasePool);

    const ingestionRepository = createIngestionRepository(databasePool);
    const ingestionService = createIngestionService({ repository: ingestionRepository });
    const logQueryRepository = createLogQueryRepository(databasePool);
    const logQueryService = createLogQueryService({ repository: logQueryRepository });

    app = buildApp({
      logger: buildLoggerOptions(config),
      readiness,
      databaseProbe: async () => probeDatabase(databasePool),
      ingestionService,
      logQueryService,
    });
    app.log.info({ attempts: databaseWait.attempts }, "Runtime database verified");
  } catch (error: unknown) {
    readiness.beginShutdown();
    await databasePool.end();
    throw error;
  }

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

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const databaseConfig = loadDatabaseConfig(process.env);

  await migrateBeforeRuntime(
    async () => {
      await runMigrationsWithOwnerRetry({
        createConnection: () => createMigrationOwnerConnection(databaseConfig),
        loadMigrations: async () => loadMigrations(MIGRATIONS_DIRECTORY),
        timeoutMs: databaseConfig.startupTimeoutMs,
        retryDelayMs: databaseConfig.retryDelayMs,
        afterMigrations: async ({ database, deadline, retryDelayMs, clock }) => {
          const partitions = buildPartitionPlan(new Date(), databaseConfig.retentionDays);
          await preparePartitions({
            database,
            partitions,
            deadline,
            retryDelayMs,
            clock,
          });
        },
      });
    },
    async () => startRuntime(config, databaseConfig),
  );
}

void main().catch(() => {
  process.stderr.write("Server startup failed.\n");
  process.exitCode = 1;
});
