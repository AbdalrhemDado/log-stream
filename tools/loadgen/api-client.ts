import { buildPrimaryAggregationUrl, validateAggregationBody } from "./aggregation.js";
import { requestJson, type HttpDependencies } from "./http.js";
import { validateIngestionResponse, type SendIngestionBatch } from "./ingestion.js";
import type { AggregationRequestResult } from "./aggregation.js";

export function createIngestionSender(
  input: { readonly baseUrl: string; readonly requestTimeoutMs: number },
  dependencies: HttpDependencies,
): SendIngestionBatch {
  return async (batch, signal) => {
    const result = await requestJson(
      {
        url: new URL("/logs", `${input.baseUrl}/`),
        method: "POST",
        timeoutMs: input.requestTimeoutMs,
        body: { logs: batch.logs },
        ...(signal === undefined ? {} : { externalSignal: signal }),
      },
      dependencies,
    );
    if (result.outcome.kind !== "success") {
      return {
        outcome: result.outcome,
        startedAtMs: result.startedAtMs,
        completedAtMs: result.completedAtMs,
        latencyMs: result.latencyMs,
      };
    }
    return {
      ...result,
      outcome: validateIngestionResponse(
        result.outcome.status,
        result.outcome.body,
        batch.logs.length,
      ),
    };
  };
}

export function createAggregationSender(
  input: {
    readonly baseUrl: string;
    readonly referenceTimeMs: number;
    readonly requestTimeoutMs: number;
  },
  dependencies: HttpDependencies,
): (signal?: AbortSignal) => Promise<AggregationRequestResult> {
  const url = buildPrimaryAggregationUrl(input.baseUrl, input.referenceTimeMs);
  return async (signal) => {
    const result = await requestJson(
      {
        url,
        method: "GET",
        timeoutMs: input.requestTimeoutMs,
        ...(signal === undefined ? {} : { externalSignal: signal }),
      },
      dependencies,
    );
    if (result.outcome.kind === "success") {
      return {
        kind: validateAggregationBody(result.outcome.body) ? "success" : "invalid-response",
        status: result.outcome.status,
        startedAtMs: result.startedAtMs,
        completedAtMs: result.completedAtMs,
        latencyMs: result.latencyMs,
      };
    }
    return {
      kind: result.outcome.kind,
      ...("status" in result.outcome ? { status: result.outcome.status } : {}),
      startedAtMs: result.startedAtMs,
      completedAtMs: result.completedAtMs,
      latencyMs: result.latencyMs,
    };
  };
}
