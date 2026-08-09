import type { FastifyInstance } from "fastify";

import type { IngestionService } from "../modules/ingestion/ingestion-service.js";

const INGESTION_SUCCESS_STATUS = 200;
const INGESTION_REJECTED_STATUS = 400;

export interface LogsRouteOptions {
  readonly ingestionService: IngestionService;
}

export function registerLogsRoute(app: FastifyInstance, options: LogsRouteOptions): void {
  app.post("/logs", async (request, reply) => {
    const response = await options.ingestionService.ingest(request.body);
    const statusCode = response.accepted > 0 ? INGESTION_SUCCESS_STATUS : INGESTION_REJECTED_STATUS;

    return reply.status(statusCode).send(response);
  });
}
