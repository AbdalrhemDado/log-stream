import type { FastifyInstance } from "fastify";

import { AppError } from "./app-error.js";

const MALFORMED_JSON_ERROR_CODE = "FST_ERR_CTP_INVALID_JSON_BODY";
const FASTIFY_ERROR_CODE_PATTERN = /^FST_[A-Z0-9_]{1,100}$/;
const MALFORMED_JSON_MESSAGE = "Malformed JSON request body.";
const INVALID_REQUEST_MESSAGE = "Invalid request.";
const INTERNAL_ERROR_MESSAGE = "Internal server error.";

export interface ErrorEnvelope {
  readonly error: string;
}

export interface MappedHttpError {
  readonly statusCode: number;
  readonly body: ErrorEnvelope;
  readonly expected: boolean;
  readonly classification: "application" | "fastify-client" | "unexpected";
  readonly frameworkErrorCode: string | undefined;
  readonly retryAfterSeconds: number | undefined;
}

interface FastifyClientError {
  readonly code: string;
  readonly statusCode: number;
}

function getFastifyClientError(error: unknown): FastifyClientError | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  if (
    !("code" in error) ||
    typeof error.code !== "string" ||
    !FASTIFY_ERROR_CODE_PATTERN.test(error.code)
  ) {
    return undefined;
  }

  if (
    !("statusCode" in error) ||
    typeof error.statusCode !== "number" ||
    !Number.isInteger(error.statusCode) ||
    error.statusCode < 400 ||
    error.statusCode > 499
  ) {
    return undefined;
  }

  return {
    code: error.code,
    statusCode: error.statusCode,
  };
}

export function mapErrorToHttp(error: unknown): MappedHttpError {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      body: { error: error.publicMessage },
      expected: true,
      classification: "application",
      frameworkErrorCode: undefined,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }

  const fastifyClientError = getFastifyClientError(error);
  if (
    fastifyClientError?.code === MALFORMED_JSON_ERROR_CODE &&
    fastifyClientError.statusCode === 400
  ) {
    return {
      statusCode: 400,
      body: { error: MALFORMED_JSON_MESSAGE },
      expected: true,
      classification: "fastify-client",
      frameworkErrorCode: fastifyClientError.code,
      retryAfterSeconds: undefined,
    };
  }

  if (fastifyClientError !== undefined) {
    return {
      statusCode: fastifyClientError.statusCode,
      body: { error: INVALID_REQUEST_MESSAGE },
      expected: true,
      classification: "fastify-client",
      frameworkErrorCode: fastifyClientError.code,
      retryAfterSeconds: undefined,
    };
  }

  return {
    statusCode: 500,
    body: { error: INTERNAL_ERROR_MESSAGE },
    expected: false,
    classification: "unexpected",
    frameworkErrorCode: undefined,
    retryAfterSeconds: undefined,
  };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const mapped = mapErrorToHttp(error);

    if (mapped.expected) {
      request.log.warn(
        {
          classification: mapped.classification,
          frameworkErrorCode: mapped.frameworkErrorCode,
          statusCode: mapped.statusCode,
        },
        "Request rejected",
      );
    } else {
      request.log.error({ err: error }, "Unhandled request error");
    }

    if (mapped.retryAfterSeconds !== undefined) {
      void reply.header("retry-after", String(mapped.retryAfterSeconds));
    }

    return reply.status(mapped.statusCode).send(mapped.body);
  });
}
