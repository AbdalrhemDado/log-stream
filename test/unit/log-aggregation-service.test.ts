import { describe, expect, it, vi } from "vitest";

import { InternalDatabaseError } from "../../src/database/database-errors.js";
import type { CanonicalUtcTimestamp } from "../../src/domain/log-entry.js";
import type { ParsedLogAggregationQuery } from "../../src/modules/aggregation/aggregation-parameter-parser.js";
import type {
  LogAggregationBucket,
  LogAggregationRepository,
} from "../../src/modules/aggregation/log-aggregation-repository.js";
import {
  createLogAggregationService,
  type LogAggregationService,
} from "../../src/modules/aggregation/log-aggregation-service.js";
import { BadRequestError, TransientServiceError } from "../../src/shared/app-error.js";

const SINCE = "2026-08-09T10:00:00.000Z" as CanonicalUtcTimestamp;
const UNTIL = "2026-08-09T12:00:00.000Z" as CanonicalUtcTimestamp;

function bucket(overrides: Partial<LogAggregationBucket> = {}): LogAggregationBucket {
  return { start: SINCE, group: null, count: 2, ...overrides };
}

function harness(
  implementation: (
    request: ParsedLogAggregationQuery,
  ) => Promise<readonly LogAggregationBucket[]> = () => Promise.resolve([]),
): { readonly service: LogAggregationService; readonly aggregate: ReturnType<typeof vi.fn> } {
  const aggregate = vi.fn(implementation);
  const repository: LogAggregationRepository = { aggregate };
  return { service: createLogAggregationService({ repository }), aggregate };
}

describe("aggregation service validation", () => {
  it.each([
    {
      name: "missing since",
      query: { until: UNTIL, bucket: "1m" },
      message: "Query parameter 'since' is required.",
    },
    {
      name: "missing until",
      query: { since: SINCE, bucket: "1m" },
      message: "Query parameter 'until' is required.",
    },
    {
      name: "missing bucket",
      query: { since: SINCE, until: UNTIL },
      message: "Query parameter 'bucket' is required.",
    },
    {
      name: "invalid bucket",
      query: { since: SINCE, until: UNTIL, bucket: "1m; DROP TABLE logs" },
      message: "Query parameter 'bucket' must be one of 1m, 5m, 1h, or 1d.",
    },
    {
      name: "invalid group",
      query: { since: SINCE, until: UNTIL, bucket: "1m", group_by: "message" },
      message: "Query parameter 'group_by' must be one of service or level.",
    },
    {
      name: "invalid shared level",
      query: { since: SINCE, until: UNTIL, bucket: "1m", level: "critical" },
      message: "Query parameter 'level' must be one of debug, info, warn, or error.",
    },
    {
      name: "earlier until",
      query: { since: UNTIL, until: SINCE, bucket: "1m" },
      message: "Query parameter 'until' must not be earlier than 'since'.",
    },
  ])("rejects $name before repository execution", async ({ query, message }) => {
    const { service, aggregate } = harness();
    const operation = service.aggregate(query);

    await expect(operation).rejects.toBeInstanceOf(BadRequestError);
    await expect(operation).rejects.toMatchObject({ statusCode: 400, publicMessage: message });
    expect(aggregate).not.toHaveBeenCalled();
  });

  it("passes the normalized request unchanged to the repository", async () => {
    const { service, aggregate } = harness();

    await service.aggregate({
      service: "checkout",
      level: "error",
      since: "2026-08-09T12:00:00+02:00",
      until: "2026-08-09T12:00:00Z",
      "attr.__proto__": "prototype",
      q: "Payment%_\\Declined",
      bucket: "5m",
      group_by: "service",
    });

    expect(aggregate).toHaveBeenCalledWith({
      filters: {
        attributes: [{ key: "__proto__", value: "prototype" }],
        service: "checkout",
        level: "error",
        since: "2026-08-09T10:00:00.000Z",
        until: "2026-08-09T12:00:00.000Z",
        q: "Payment%_\\Declined",
      },
      bucket: "5m",
      groupBy: "service",
    });
  });

  it("passes equal bounds to the repository", async () => {
    const { service, aggregate } = harness();

    await service.aggregate({ since: SINCE, until: SINCE, bucket: "1h" });

    expect(aggregate).toHaveBeenCalledOnce();
  });
});

describe("aggregation service response and failures", () => {
  it("wraps ordered repository buckets in the exact response", async () => {
    const buckets = [bucket(), bucket({ start: UNTIL, group: "checkout", count: 1 })];
    const { service } = harness(() => Promise.resolve(buckets));

    await expect(service.aggregate({ since: SINCE, until: UNTIL, bucket: "1m" })).resolves.toEqual({
      buckets,
    });
  });

  it("returns the exact empty response", async () => {
    const { service } = harness();

    await expect(service.aggregate({ since: SINCE, until: UNTIL, bucket: "1m" })).resolves.toEqual({
      buckets: [],
    });
  });

  it.each([new InternalDatabaseError(), new TransientServiceError()])(
    "propagates repository errors without wrapping",
    async (source) => {
      const { service } = harness(() => Promise.reject(source));

      let thrown: unknown;
      try {
        await service.aggregate({ since: SINCE, until: UNTIL, bucket: "1m" });
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBe(source);
    },
  );
});
