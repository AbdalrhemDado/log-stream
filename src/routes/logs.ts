import type { FastifyInstance } from "fastify";

import type { IngestionService } from "../modules/ingestion/ingestion-service.js";
import type { LogAggregationService } from "../modules/aggregation/log-aggregation-service.js";
import type { LogQueryService } from "../modules/query/log-query-service.js";

const INGESTION_SUCCESS_STATUS = 200;
const INGESTION_REJECTED_STATUS = 400;

export interface LogsRouteOptions {
  readonly ingestionService?: IngestionService;
  readonly logAggregationService?: LogAggregationService;
  readonly logQueryService?: LogQueryService;
}

export function registerLogsRoute(app: FastifyInstance, options: LogsRouteOptions): void {
  const ingestionService = options.ingestionService;
  if (ingestionService !== undefined) {
    app.post("/logs", async (request, reply) => {
      const response = await ingestionService.ingest(request.body);
      const statusCode =
        response.accepted > 0 ? INGESTION_SUCCESS_STATUS : INGESTION_REJECTED_STATUS;

      return reply.status(statusCode).send(response);
    });
  }

  const logQueryService = options.logQueryService;
  if (logQueryService !== undefined) {
    app.get("/logs", async (request, reply) => {
      const response = await logQueryService.list(request.query);

      return reply.status(200).send(response);
    });
  }

  const logAggregationService = options.logAggregationService;
  if (logAggregationService !== undefined) {
    app.get("/logs/aggregate", async (request, reply) => {
      const response = await logAggregationService.aggregate(request.query);

      return reply.status(200).send(response);
    });
  }
}
