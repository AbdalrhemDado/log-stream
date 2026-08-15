import type { NormalizedSearchAttributes, OriginalAttributes } from "./attributes.js";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

declare const canonicalUtcTimestampBrand: unique symbol;
declare const logIdBrand: unique symbol;

/** A timezone-bearing timestamp that runtime validation has normalized to UTC. */
export type CanonicalUtcTimestamp = string & {
  readonly [canonicalUtcTimestampBrand]: "CanonicalUtcTimestamp";
};

/** A UUID v4 that the application has generated for a log entry. */
export type LogId = string & {
  readonly [logIdBrand]: "LogId";
};

export interface ValidatedLogEntry {
  readonly timestamp: CanonicalUtcTimestamp;
  readonly level: LogLevel;
  readonly service: string;
  readonly message: string;
  readonly attributes: OriginalAttributes;
}

export interface NormalizedLogEntry extends ValidatedLogEntry {
  readonly attributesSearch: NormalizedSearchAttributes;
}

export interface LogInsertionRecord {
  readonly id: LogId;
  readonly timestamp: CanonicalUtcTimestamp;
  readonly level: LogLevel;
  readonly service: string;
  readonly message: string;
  readonly attributes: OriginalAttributes;
}

export interface ApiLogResponseItem {
  readonly id: LogId;
  readonly timestamp: CanonicalUtcTimestamp;
  readonly level: LogLevel;
  readonly service: string;
  readonly message: string;
  readonly attributes: OriginalAttributes;
}
