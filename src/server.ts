import { buildApp } from "./app.js";
import { loadConfig } from "./config/app-config.js";
import { installServerLifecycle, type ShutdownSignalSource } from "./server-lifecycle.js";
import { buildLoggerOptions } from "./shared/logging.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const app = buildApp({ logger: buildLoggerOptions(config) });
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
    closeApplication: async () => app.close(),
    onShutdownStarted: (signal) => {
      app.log.info({ signal }, "Application shutdown started");
    },
    onShutdownFailed: (error, signal) => {
      app.log.error({ err: error, signal }, "Application shutdown failed");
      process.exitCode = 1;
    },
  });

  try {
    await app.listen({
      host: config.host,
      port: config.port,
    });
  } catch (error: unknown) {
    lifecycle.dispose();
    throw error;
  }
}

void main().catch(() => {
  process.stderr.write("Server startup failed.\n");
  process.exitCode = 1;
});
