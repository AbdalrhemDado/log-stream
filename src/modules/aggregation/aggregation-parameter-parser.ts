import type { CanonicalUtcTimestamp } from "../../domain/log-entry.js";
import {
  parseLogFilters,
  type LogFilters,
  type QueryErrorEnvelope,
  type QueryParseResult,
} from "../query/query-parameter-parser.js";

export const AGGREGATION_BUCKETS = ["1m", "5m", "1h", "1d"] as const;

export type AggregationBucket = (typeof AGGREGATION_BUCKETS)[number];

export const AGGREGATION_GROUPS = ["service", "level"] as const;

export type AggregationGroupBy = (typeof AGGREGATION_GROUPS)[number];

export interface RequiredAggregationFilters extends LogFilters {
  readonly since: CanonicalUtcTimestamp;
  readonly until: CanonicalUtcTimestamp;
}

export interface ParsedLogAggregationQuery {
  readonly filters: RequiredAggregationFilters;
  readonly bucket: AggregationBucket;
  readonly groupBy?: AggregationGroupBy;
}

const ERRORS = {
  sinceRequired: "Query parameter 'since' is required.",
  untilRequired: "Query parameter 'until' is required.",
  bucketRequired: "Query parameter 'bucket' is required.",
  bucketDuplicate: "Query parameter 'bucket' must appear at most once.",
  bucketValue: "Query parameter 'bucket' must be one of 1m, 5m, 1h, or 1d.",
  groupByDuplicate: "Query parameter 'group_by' must appear at most once.",
  groupByValue: "Query parameter 'group_by' must be one of service or level.",
} as const;

type ScalarReadResult =
  | { readonly kind: "absent" }
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "failure"; readonly error: QueryErrorEnvelope };

function failure<T>(message: string): QueryParseResult<T> {
  return { ok: false, error: { error: message } };
}

function isQueryObject(input: unknown): input is object {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function readAggregationScalar(
  input: unknown,
  key: "bucket" | "group_by",
  duplicateMessage: string,
  invalidMessage: string,
): ScalarReadResult {
  if (!isQueryObject(input)) {
    return { kind: "failure", error: { error: invalidMessage } };
  }

  const descriptor = Object.getOwnPropertyDescriptor(input, key);

  if (descriptor?.enumerable !== true) {
    return { kind: "absent" };
  }

  if (!("value" in descriptor)) {
    return { kind: "failure", error: { error: invalidMessage } };
  }

  if (Array.isArray(descriptor.value)) {
    return { kind: "failure", error: { error: duplicateMessage } };
  }

  if (typeof descriptor.value !== "string") {
    return { kind: "failure", error: { error: invalidMessage } };
  }

  return { kind: "value", value: descriptor.value };
}

function isAggregationBucket(value: string): value is AggregationBucket {
  return AGGREGATION_BUCKETS.some((bucket) => bucket === value);
}

function isAggregationGroupBy(value: string): value is AggregationGroupBy {
  return AGGREGATION_GROUPS.some((group) => group === value);
}

export function parseLogAggregationQuery(
  input: unknown,
): QueryParseResult<ParsedLogAggregationQuery> {
  const sharedFilters = parseLogFilters(input);

  if (!sharedFilters.ok) {
    return sharedFilters;
  }

  if (sharedFilters.value.since === undefined) {
    return failure(ERRORS.sinceRequired);
  }

  if (sharedFilters.value.until === undefined) {
    return failure(ERRORS.untilRequired);
  }

  const bucket = readAggregationScalar(input, "bucket", ERRORS.bucketDuplicate, ERRORS.bucketValue);

  if (bucket.kind === "failure") {
    return { ok: false, error: bucket.error };
  }

  if (bucket.kind === "absent") {
    return failure(ERRORS.bucketRequired);
  }

  if (!isAggregationBucket(bucket.value)) {
    return failure(ERRORS.bucketValue);
  }

  const groupBy = readAggregationScalar(
    input,
    "group_by",
    ERRORS.groupByDuplicate,
    ERRORS.groupByValue,
  );

  if (groupBy.kind === "failure") {
    return { ok: false, error: groupBy.error };
  }

  let parsedGroupBy: AggregationGroupBy | undefined;

  if (groupBy.kind === "value") {
    if (!isAggregationGroupBy(groupBy.value)) {
      return failure(ERRORS.groupByValue);
    }

    parsedGroupBy = groupBy.value;
  }

  const filters: RequiredAggregationFilters = {
    ...sharedFilters.value,
    since: sharedFilters.value.since,
    until: sharedFilters.value.until,
  };

  return {
    ok: true,
    value: {
      filters,
      bucket: bucket.value,
      ...(parsedGroupBy === undefined ? {} : { groupBy: parsedGroupBy }),
    },
  };
}
