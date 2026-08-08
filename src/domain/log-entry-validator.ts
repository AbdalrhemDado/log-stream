import type { AttributeValue, OriginalAttributes } from "./attributes.js";
import type { ValidationResult } from "./ingestion.js";
import {
  LOG_LEVELS,
  type CanonicalUtcTimestamp,
  type LogLevel,
  type ValidatedLogEntry,
} from "./log-entry.js";

const FIVE_MINUTES_MS = 300_000;

const REASONS = {
  entryObject: "log entry must be a non-null object",
  timestampRequired: "timestamp is required",
  timestampString: "timestamp must be a string",
  timestampGrammar: "timestamp must be a timezone-bearing ISO 8601 date-time",
  timestampComponents: "timestamp contains an invalid calendar date or time",
  timestampFuture: "timestamp must not be more than five minutes in the future",
  levelRequired: "level is required",
  levelString: "level must be a string",
  levelValue: "level must be one of debug, info, warn, or error",
  serviceRequired: "service is required",
  serviceString: "service must be a string",
  serviceEmpty: "service must be non-empty",
  messageRequired: "message is required",
  messageString: "message must be a string",
  messageEmpty: "message must be non-empty",
  attributesObject: "attributes must be a non-null object",
  attributeValue: "attribute values must be strings, finite numbers, or booleans",
} as const;

const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

type TimestampParseResult =
  | {
      readonly ok: true;
      readonly wholeSecondMs: number;
      readonly fraction: string;
      readonly canonical: CanonicalUtcTimestamp;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

type AttributeValidationResult =
  | {
      readonly ok: true;
      readonly value: OriginalAttributes;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

function failure(reason: string): ValidationResult {
  return { ok: false, reason };
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isLogLevel(value: string): value is LogLevel {
  return LOG_LEVELS.some((level) => level === value);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function formatCanonicalFraction(fraction: string): string {
  const atLeastMilliseconds = fraction.padEnd(3, "0");
  const milliseconds = atLeastMilliseconds.slice(0, 3);
  const significantSubMilliseconds = atLeastMilliseconds.slice(3).replace(/0+$/, "");

  return `${milliseconds}${significantSubMilliseconds}`;
}

function parseTimestamp(value: string): TimestampParseResult {
  const match = TIMESTAMP_PATTERN.exec(value);

  if (match === null) {
    return { ok: false, reason: REASONS.timestampGrammar };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const timezone = match[8];

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59 ||
    timezone === undefined
  ) {
    return { ok: false, reason: REASONS.timestampComponents };
  }

  let offsetMinutes = 0;

  if (timezone !== "Z") {
    const sign = match[9];
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);

    if (
      (sign !== "+" && sign !== "-") ||
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return { ok: false, reason: REASONS.timestampComponents };
    }

    const direction = sign === "+" ? 1 : -1;
    offsetMinutes = direction * (offsetHour * 60 + offsetMinute);
  }

  const localDate = new Date(0);
  localDate.setUTCFullYear(year, month - 1, day);
  localDate.setUTCHours(hour, minute, second, 0);

  const wholeSecondMs = localDate.getTime() - offsetMinutes * 60_000;
  const canonicalBase = new Date(wholeSecondMs).toISOString().replace(/\.000Z$/, "");
  const canonicalFraction = formatCanonicalFraction(fraction);
  const canonical = `${canonicalBase}.${canonicalFraction}Z` as CanonicalUtcTimestamp;

  return { ok: true, wholeSecondMs, fraction, canonical };
}

function isAfterFutureLimit(
  timestamp: TimestampParseResult & { readonly ok: true },
  limitMs: number,
): boolean {
  const limitWholeSecondMs = Math.floor(limitMs / 1_000) * 1_000;

  if (timestamp.wholeSecondMs !== limitWholeSecondMs) {
    return timestamp.wholeSecondMs > limitWholeSecondMs;
  }

  const timestampMilliseconds = Number(timestamp.fraction.slice(0, 3).padEnd(3, "0"));
  const limitMilliseconds = Math.trunc(limitMs - limitWholeSecondMs);

  if (timestampMilliseconds !== limitMilliseconds) {
    return timestampMilliseconds > limitMilliseconds;
  }

  const remainingDigits = timestamp.fraction.slice(3);

  return /[1-9]/.test(remainingDigits);
}

function isAttributeValue(value: unknown): value is AttributeValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function validateAttributes(value: unknown): AttributeValidationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: REASONS.attributesObject };
  }

  const safeAttributes = Object.create(null) as Record<string, AttributeValue>;

  for (const [key, attributeValue] of Object.entries(value)) {
    if (!isAttributeValue(attributeValue)) {
      return { ok: false, reason: REASONS.attributeValue };
    }

    safeAttributes[key] = attributeValue;
  }

  return { ok: true, value: safeAttributes as OriginalAttributes };
}

export function validateLogEntry(input: unknown, referenceTimeMs: number): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return failure(REASONS.entryObject);
  }

  const entry = input as Record<string, unknown>;

  if (!hasOwn(entry, "timestamp")) {
    return failure(REASONS.timestampRequired);
  }

  if (typeof entry["timestamp"] !== "string") {
    return failure(REASONS.timestampString);
  }

  const timestamp = parseTimestamp(entry["timestamp"]);

  if (!timestamp.ok) {
    return failure(timestamp.reason);
  }

  if (isAfterFutureLimit(timestamp, referenceTimeMs + FIVE_MINUTES_MS)) {
    return failure(REASONS.timestampFuture);
  }

  if (!hasOwn(entry, "level")) {
    return failure(REASONS.levelRequired);
  }

  if (typeof entry["level"] !== "string") {
    return failure(REASONS.levelString);
  }

  if (!isLogLevel(entry["level"])) {
    return failure(REASONS.levelValue);
  }

  if (!hasOwn(entry, "service")) {
    return failure(REASONS.serviceRequired);
  }

  if (typeof entry["service"] !== "string") {
    return failure(REASONS.serviceString);
  }

  if (entry["service"].length === 0) {
    return failure(REASONS.serviceEmpty);
  }

  if (!hasOwn(entry, "message")) {
    return failure(REASONS.messageRequired);
  }

  if (typeof entry["message"] !== "string") {
    return failure(REASONS.messageString);
  }

  if (entry["message"].length === 0) {
    return failure(REASONS.messageEmpty);
  }

  const attributes = validateAttributes(hasOwn(entry, "attributes") ? entry["attributes"] : {});

  if (!attributes.ok) {
    return failure(attributes.reason);
  }

  const value: ValidatedLogEntry = {
    timestamp: timestamp.canonical,
    level: entry["level"],
    service: entry["service"],
    message: entry["message"],
    attributes: attributes.value,
  };

  return { ok: true, value };
}
