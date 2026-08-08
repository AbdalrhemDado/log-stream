import { randomUUID } from "node:crypto";

import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from "fastify";

import { registerErrorHandler } from "./shared/error-handler.js";

const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_LOG_LABEL = "requestId";

export interface BuildAppOptions {
  readonly logger?: FastifyServerOptions["logger"];
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
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

  return app;
}
