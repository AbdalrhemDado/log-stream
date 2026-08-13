import type { CanonicalUtcTimestamp } from "./log-entry.js";

const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;
const CANONICAL_MILLISECOND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(\d{3})Z$/;

export type TimestampParseFailureKind = "grammar" | "components";

export interface ParsedTimestamp {
  readonly canonical: CanonicalUtcTimestamp;
  readonly wholeSecondMs: number;
  readonly fraction: string;
}

export type TimestampParseResult =
  | {
      readonly ok: true;
      readonly value: ParsedTimestamp;
    }
  | {
      readonly ok: false;
      readonly kind: TimestampParseFailureKind;
    };

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

function compareFractions(left: string, right: string): -1 | 0 | 1 {
  const width = Math.max(left.length, right.length);
  const normalizedLeft = left.padEnd(width, "0");
  const normalizedRight = right.padEnd(width, "0");

  if (normalizedLeft < normalizedRight) {
    return -1;
  }

  if (normalizedLeft > normalizedRight) {
    return 1;
  }

  return 0;
}

export function parseCanonicalTimestamp(value: string): TimestampParseResult {
  const canonicalMilliseconds = CANONICAL_MILLISECOND_PATTERN.exec(value);

  if (canonicalMilliseconds !== null) {
    const epochMs = Date.parse(value);

    if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString() !== value) {
      return { ok: false, kind: "components" };
    }

    return {
      ok: true,
      value: {
        canonical: value as CanonicalUtcTimestamp,
        wholeSecondMs: Math.floor(epochMs / 1_000) * 1_000,
        fraction: canonicalMilliseconds[1] ?? "",
      },
    };
  }

  const match = TIMESTAMP_PATTERN.exec(value);

  if (match === null) {
    return { ok: false, kind: "grammar" };
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
    return { ok: false, kind: "components" };
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
      return { ok: false, kind: "components" };
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

  return {
    ok: true,
    value: {
      canonical,
      wholeSecondMs,
      fraction,
    },
  };
}

export function compareParsedTimestamps(left: ParsedTimestamp, right: ParsedTimestamp): -1 | 0 | 1 {
  if (left.wholeSecondMs < right.wholeSecondMs) {
    return -1;
  }

  if (left.wholeSecondMs > right.wholeSecondMs) {
    return 1;
  }

  return compareFractions(left.fraction, right.fraction);
}

export function isParsedTimestampAfterEpochMilliseconds(
  timestamp: ParsedTimestamp,
  limitMs: number,
): boolean {
  const limitWholeSecondMs = Math.floor(limitMs / 1_000) * 1_000;

  if (timestamp.wholeSecondMs !== limitWholeSecondMs) {
    return timestamp.wholeSecondMs > limitWholeSecondMs;
  }

  const limitMilliseconds = Math.trunc(limitMs - limitWholeSecondMs);
  const limitFraction = String(limitMilliseconds).padStart(3, "0");

  return compareFractions(timestamp.fraction, limitFraction) > 0;
}
