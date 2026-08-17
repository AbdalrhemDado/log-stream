import { randomUUID } from "node:crypto";

import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from "fastify";

import type { DatabaseProbe } from "./database/database-pool.js";
import type { LogAggregationService } from "./modules/aggregation/log-aggregation-service.js";
import type { IngestionService } from "./modules/ingestion/ingestion-service.js";
import type { LogQueryService } from "./modules/query/log-query-service.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerLogsRoute } from "./routes/logs.js";
import { registerErrorHandler } from "./shared/error-handler.js";
import { createReadiness, type Readiness } from "./shared/readiness.js";

const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_LOG_LABEL = "requestId";

export interface BuildAppOptions {
  readonly logger?: FastifyServerOptions["logger"];
  readonly readiness?: Readiness;
  readonly databaseProbe?: DatabaseProbe;
  readonly ingestionService?: IngestionService;
  readonly logAggregationService?: LogAggregationService;
  readonly logQueryService?: LogQueryService;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const readiness = options.readiness ?? createReadiness();
  const databaseProbe =
    options.databaseProbe ??
    (() => Promise.reject(new Error("No database probe is configured for this application.")));
  const app = Fastify({
    bodyLimit: 20 * 1024 * 1024,
    genReqId: () => randomUUID(),
    logController: new LogController({
      disableRequestLogging: (request) => request.method === "POST" && request.url === "/logs",
      requestIdLogLabel: REQUEST_ID_LOG_LABEL,
    }),
    logger: options.logger ?? false,
    onConstructorPoisoning: "ignore",
    onProtoPoisoning: "ignore",
    requestIdHeader: false,
  });

  app.addHook("onRequest", (request, reply, done) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });

  registerErrorHandler(app);
  registerHealthRoute(app, { readiness, databaseProbe });
  if (
    options.ingestionService !== undefined ||
    options.logAggregationService !== undefined ||
    options.logQueryService !== undefined
  ) {
    registerLogsRoute(app, {
      ...(options.ingestionService === undefined
        ? {}
        : { ingestionService: options.ingestionService }),
      ...(options.logAggregationService === undefined
        ? {}
        : { logAggregationService: options.logAggregationService }),
      ...(options.logQueryService === undefined
        ? {}
        : { logQueryService: options.logQueryService }),
    });
  }

  return app;
}
