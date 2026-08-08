import type { FastifyInstance } from "fastify";

import type { DatabaseProbe } from "../database/database-pool.js";
import type { Readiness } from "../shared/readiness.js";

const HEALTH_UNAVAILABLE_STATUS = 503;

export interface HealthRouteOptions {
  readonly readiness: Readiness;
  readonly databaseProbe: DatabaseProbe;
}

export function registerHealthRoute(app: FastifyInstance, options: HealthRouteOptions): void {
  app.get("/health", async (_request, reply) => {
    if (options.readiness.state === "starting" || options.readiness.state === "stopping") {
      return reply.status(HEALTH_UNAVAILABLE_STATUS).send({ status: "unavailable" });
    }

    try {
      await options.databaseProbe();
      options.readiness.markReady();
    } catch {
      options.readiness.markUnavailable();
    }

    if (!options.readiness.isReady) {
      return reply.status(HEALTH_UNAVAILABLE_STATUS).send({ status: "unavailable" });
    }

    return reply.status(200).send({ status: "ok" });
  });
}
