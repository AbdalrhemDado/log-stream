import { LOG_LEVELS, type CanonicalUtcTimestamp, type LogLevel } from "../../domain/log-entry.js";
import {
  compareParsedTimestamps,
  parseCanonicalTimestamp,
  type ParsedTimestamp,
} from "../../domain/timestamp.js";

const ATTRIBUTE_PREFIX = "attr.";
const DEFAULT_LIMIT = 100;
const MINIMUM_LIMIT = 1;
const MAXIMUM_LIMIT = 1_000;
const BASE_TEN_INTEGER_PATTERN = /^[0-9]+$/;

const ERRORS = {
  queryObject: "Query parameters must be a non-null object.",
  serviceDuplicate: "Query parameter 'service' must appear at most once.",
  serviceString: "Query parameter 'service' must be a string.",
  serviceNul: "Query parameter 'service' must not contain U+0000.",
  levelDuplicate: "Query parameter 'level' must appear at most once.",
  levelString: "Query parameter 'level' must be a string.",
  levelValue: "Query parameter 'level' must be one of debug, info, warn, or error.",
  sinceDuplicate: "Query parameter 'since' must appear at most once.",
  sinceTimestamp: "Query parameter 'since' must be a valid timezone-bearing ISO 8601 date-time.",
  untilDuplicate: "Query parameter 'until' must appear at most once.",
  untilTimestamp: "Query parameter 'until' must be a valid timezone-bearing ISO 8601 date-time.",
  range: "Query parameter 'until' must not be earlier than 'since'.",
  attributeKey: "Attribute query parameters must include a non-empty key after 'attr.'.",
  attributeDuplicate: "Each attribute query key must appear at most once.",
  attributeString: "Attribute query parameter values must be strings.",
  attributeKeyNul: "Attribute query keys must not contain U+0000.",
  attributeValueNul: "Attribute query values must not contain U+0000.",
  qDuplicate: "Query parameter 'q' must appear at most once.",
  qString: "Query parameter 'q' must be a string.",
  qNul: "Query parameter 'q' must not contain U+0000.",
  limitDuplicate: "Query parameter 'limit' must appear at most once.",
  limitValue: "Query parameter 'limit' must be a base-10 integer from 1 to 1000.",
  cursorDuplicate: "Query parameter 'cursor' must appear at most once.",
  cursorValue: "Query parameter 'cursor' must be a non-empty string.",
} as const;

export interface AttributeFilter {
  readonly key: string;
  readonly value: string;
}

export interface LogFilters {
  readonly service?: string;
  readonly level?: LogLevel;
  readonly since?: CanonicalUtcTimestamp;
  readonly until?: CanonicalUtcTimestamp;
  readonly attributes: readonly AttributeFilter[];
  readonly q?: string;
}

export interface ParsedLogListQuery {
  readonly filters: LogFilters;
  readonly limit: number;
  readonly cursor?: string;
}

export interface QueryErrorEnvelope {
  readonly error: string;
}

export type QueryParseResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: QueryErrorEnvelope;
    };

type ScalarReadResult =
  | { readonly kind: "absent" }
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "failure"; readonly error: QueryErrorEnvelope };

interface ParsedOptionalTimestamp {
  readonly parsed: ParsedTimestamp;
  readonly canonical: CanonicalUtcTimestamp;
}

function failure<T>(message: string): QueryParseResult<T> {
  return { ok: false, error: { error: message } };
}

function isQueryObject(input: unknown): input is object {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function readScalar(
  query: object,
  key: string,
  duplicateMessage: string,
  invalidMessage: string,
): ScalarReadResult {
  const descriptor = Object.getOwnPropertyDescriptor(query, key);

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

function compareCodeUnits(left: string, right: string): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function containsUnicodeNul(value: string): boolean {
  return value.includes("\u0000");
}

function isLogLevel(value: string): value is LogLevel {
  return LOG_LEVELS.some((level) => level === value);
}

function parseOptionalTimestamp(
  query: object,
  key: "since" | "until",
): QueryParseResult<ParsedOptionalTimestamp | undefined> {
  const duplicateMessage = key === "since" ? ERRORS.sinceDuplicate : ERRORS.untilDuplicate;
  const invalidMessage = key === "since" ? ERRORS.sinceTimestamp : ERRORS.untilTimestamp;
  const scalar = readScalar(query, key, duplicateMessage, invalidMessage);

  if (scalar.kind === "failure") {
    return { ok: false, error: scalar.error };
  }

  if (scalar.kind === "absent") {
    return { ok: true, value: undefined };
  }

  const timestamp = parseCanonicalTimestamp(scalar.value);

  if (!timestamp.ok) {
    return failure(invalidMessage);
  }

  return {
    ok: true,
    value: {
      parsed: timestamp.value,
      canonical: timestamp.value.canonical,
    },
  };
}

function parseAttributeFilters(query: object): QueryParseResult<readonly AttributeFilter[]> {
  const names = Object.keys(query)
    .filter((name) => name.startsWith(ATTRIBUTE_PREFIX))
    .sort(compareCodeUnits);
  const attributes: AttributeFilter[] = [];

  for (const name of names) {
    const key = name.slice(ATTRIBUTE_PREFIX.length);

    if (key.length === 0) {
      return failure(ERRORS.attributeKey);
    }

    if (containsUnicodeNul(key)) {
      return failure(ERRORS.attributeKeyNul);
    }

    const scalar = readScalar(query, name, ERRORS.attributeDuplicate, ERRORS.attributeString);

    if (scalar.kind === "failure") {
      return { ok: false, error: scalar.error };
    }

    if (scalar.kind === "absent") {
      continue;
    }

    if (containsUnicodeNul(scalar.value)) {
      return failure(ERRORS.attributeValueNul);
    }

    attributes.push({ key, value: scalar.value });
  }

  return { ok: true, value: attributes };
}

export function parseLogFilters(input: unknown): QueryParseResult<LogFilters> {
  if (!isQueryObject(input)) {
    return failure(ERRORS.queryObject);
  }

  const service = readScalar(input, "service", ERRORS.serviceDuplicate, ERRORS.serviceString);

  if (service.kind === "failure") {
    return { ok: false, error: service.error };
  }

  if (service.kind === "value" && containsUnicodeNul(service.value)) {
    return failure(ERRORS.serviceNul);
  }

  const level = readScalar(input, "level", ERRORS.levelDuplicate, ERRORS.levelString);

  if (level.kind === "failure") {
    return { ok: false, error: level.error };
  }

  let parsedLevel: LogLevel | undefined;

  if (level.kind === "value") {
    if (!isLogLevel(level.value)) {
      return failure(ERRORS.levelValue);
    }

    parsedLevel = level.value;
  }

  const since = parseOptionalTimestamp(input, "since");

  if (!since.ok) {
    return since;
  }

  const until = parseOptionalTimestamp(input, "until");

  if (!until.ok) {
    return until;
  }

  if (
    since.value !== undefined &&
    until.value !== undefined &&
    compareParsedTimestamps(until.value.parsed, since.value.parsed) < 0
  ) {
    return failure(ERRORS.range);
  }

  const attributes = parseAttributeFilters(input);

  if (!attributes.ok) {
    return attributes;
  }

  const q = readScalar(input, "q", ERRORS.qDuplicate, ERRORS.qString);

  if (q.kind === "failure") {
    return { ok: false, error: q.error };
  }

  if (q.kind === "value" && containsUnicodeNul(q.value)) {
    return failure(ERRORS.qNul);
  }

  const filters: LogFilters = {
    attributes: attributes.value,
    ...(service.kind === "value" ? { service: service.value } : {}),
    ...(parsedLevel === undefined ? {} : { level: parsedLevel }),
    ...(since.value === undefined ? {} : { since: since.value.canonical }),
    ...(until.value === undefined ? {} : { until: until.value.canonical }),
    ...(q.kind === "value" && q.value.length > 0 ? { q: q.value } : {}),
  };

  return { ok: true, value: filters };
}

function parseLimit(query: object): QueryParseResult<number> {
  const limit = readScalar(query, "limit", ERRORS.limitDuplicate, ERRORS.limitValue);

  if (limit.kind === "failure") {
    return { ok: false, error: limit.error };
  }

  if (limit.kind === "absent") {
    return { ok: true, value: DEFAULT_LIMIT };
  }

  if (!BASE_TEN_INTEGER_PATTERN.test(limit.value)) {
    return failure(ERRORS.limitValue);
  }

  const parsed = Number(limit.value);

  if (!Number.isSafeInteger(parsed) || parsed < MINIMUM_LIMIT || parsed > MAXIMUM_LIMIT) {
    return failure(ERRORS.limitValue);
  }

  return { ok: true, value: parsed };
}

export function parseLogListQuery(input: unknown): QueryParseResult<ParsedLogListQuery> {
  const filters = parseLogFilters(input);

  if (!filters.ok) {
    return filters;
  }

  if (!isQueryObject(input)) {
    return failure(ERRORS.queryObject);
  }

  const limit = parseLimit(input);

  if (!limit.ok) {
    return limit;
  }

  const cursor = readScalar(input, "cursor", ERRORS.cursorDuplicate, ERRORS.cursorValue);

  if (cursor.kind === "failure") {
    return { ok: false, error: cursor.error };
  }

  if (cursor.kind === "value" && cursor.value.length === 0) {
    return failure(ERRORS.cursorValue);
  }

  const value: ParsedLogListQuery = {
    filters: filters.value,
    limit: limit.value,
    ...(cursor.kind === "value" ? { cursor: cursor.value } : {}),
  };

  return { ok: true, value };
}
