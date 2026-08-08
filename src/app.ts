import { randomUUID } from "node:crypto";

import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from "fastify";

import type { DatabaseProbe } from "./database/database-pool.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerErrorHandler } from "./shared/error-handler.js";
import { createReadiness, type Readiness } from "./shared/readiness.js";

const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_LOG_LABEL = "requestId";

export interface BuildAppOptions {
  readonly logger?: FastifyServerOptions["logger"];
  readonly readiness?: Readiness;
  readonly databaseProbe?: DatabaseProbe;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const readiness = options.readiness ?? createReadiness();
  const databaseProbe =
    options.databaseProbe ??
    (() => Promise.reject(new Error("No database probe is configured for this application.")));
  const app = Fastify({
    genReqId: () => randomUUID(),
    logController: new LogController({
      requestIdLogLabel: REQUEST_ID_LOG_LABEL,
    }),
    logger: options.logger ?? false,
    requestIdHeader: false,
  });

  app.addHook("onRequest", (request, reply, done) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });

  registerErrorHandler(app);
  registerHealthRoute(app, { readiness, databaseProbe });

  return app;
}
