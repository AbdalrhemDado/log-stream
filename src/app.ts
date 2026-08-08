import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

export interface BuildAppOptions {
  readonly logger?: FastifyServerOptions["logger"];
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  return Fastify({
    logger: options.logger ?? false,
  });
}
