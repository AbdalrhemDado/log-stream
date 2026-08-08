import { buildApp } from "./app.js";
import { loadConfig } from "./config/app-config.js";
import { buildLoggerOptions } from "./shared/logging.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const app = buildApp({ logger: buildLoggerOptions(config) });

  await app.listen({
    host: config.host,
    port: config.port,
  });
}

void main().catch(() => {
  process.stderr.write("Server startup failed.\n");
  process.exitCode = 1;
});
