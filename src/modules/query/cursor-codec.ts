import { createHash } from "node:crypto";

import type { CanonicalUtcTimestamp, LogId } from "../../domain/log-entry.js";
import { parseCanonicalTimestamp } from "../../domain/timestamp.js";
import type { AttributeFilter, LogFilters, QueryErrorEnvelope } from "./query-parameter-parser.js";

const CURSOR_VERSION = 1;
const CURSOR_SEMANTICS = "logstream.cursor.timestamp-desc-id-desc.v1";
const INVALID_CURSOR_MESSAGE = "Query parameter 'cursor' is invalid.";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA_256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const PAYLOAD_KEYS = ["version", "timestamp", "id", "filterFingerprint"] as const;

export interface LogCursorPosition {
  readonly timestamp: CanonicalUtcTimestamp;
  readonly id: LogId;
}

export type CursorDecodeResult =
  | {
      readonly ok: true;
      readonly value: LogCursorPosition;
    }
  | {
      readonly ok: false;
      readonly error: QueryErrorEnvelope;
    };

interface CursorPayload {
  readonly version: number;
  readonly timestamp: unknown;
  readonly id: unknown;
  readonly filterFingerprint: unknown;
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

function compareAttributes(left: AttributeFilter, right: AttributeFilter): -1 | 0 | 1 {
  const keyComparison = compareCodeUnits(left.key, right.key);
  return keyComparison === 0 ? compareCodeUnits(left.value, right.value) : keyComparison;
}

function canonicalFilterJson(filters: LogFilters): string {
  const attributes = [...filters.attributes]
    .sort(compareAttributes)
    .map(({ key, value }) => [key, value] as const);

  return JSON.stringify({
    semantics: CURSOR_SEMANTICS,
    service: filters.service ?? null,
    level: filters.level ?? null,
    since: filters.since ?? null,
    until: filters.until ?? null,
    q: filters.q === undefined || filters.q.length === 0 ? null : filters.q,
    attributes,
  });
}

function filterFingerprint(filters: LogFilters): string {
  return createHash("sha256").update(canonicalFilterJson(filters), "utf8").digest("hex");
}

function payloadJson(payload: CursorPayload): string {
  return JSON.stringify({
    version: payload.version,
    timestamp: payload.timestamp,
    id: payload.id,
    filterFingerprint: payload.filterFingerprint,
  });
}

function invalidCursor(): CursorDecodeResult {
  return { ok: false, error: { error: INVALID_CURSOR_MESSAGE } };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactPayloadKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === PAYLOAD_KEYS.length && PAYLOAD_KEYS.every((key) => Object.hasOwn(value, key))
  );
}

export function encodeLogCursor(position: LogCursorPosition, filters: LogFilters): string {
  const payload: CursorPayload = {
    version: CURSOR_VERSION,
    timestamp: position.timestamp,
    id: position.id,
    filterFingerprint: filterFingerprint(filters),
  };

  return Buffer.from(payloadJson(payload), "utf8").toString("base64url");
}

export function decodeLogCursor(cursor: string, filters: LogFilters): CursorDecodeResult {
  try {
    if (!BASE64URL_PATTERN.test(cursor)) {
      return invalidCursor();
    }

    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) {
      return invalidCursor();
    }

    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(json, "utf8").equals(bytes)) {
      return invalidCursor();
    }

    const candidate: unknown = JSON.parse(json);

    if (!isJsonObject(candidate) || !hasExactPayloadKeys(candidate)) {
      return invalidCursor();
    }

    const payload: CursorPayload = {
      version: candidate["version"] as number,
      timestamp: candidate["timestamp"],
      id: candidate["id"],
      filterFingerprint: candidate["filterFingerprint"],
    };

    if (payloadJson(payload) !== json) {
      return invalidCursor();
    }

    if (
      payload.version !== CURSOR_VERSION ||
      typeof payload.timestamp !== "string" ||
      typeof payload.id !== "string" ||
      typeof payload.filterFingerprint !== "string" ||
      !UUID_V4_PATTERN.test(payload.id) ||
      !SHA_256_HEX_PATTERN.test(payload.filterFingerprint)
    ) {
      return invalidCursor();
    }

    const timestamp = parseCanonicalTimestamp(payload.timestamp);
    if (!timestamp.ok || timestamp.value.canonical !== payload.timestamp) {
      return invalidCursor();
    }

    if (payload.filterFingerprint !== filterFingerprint(filters)) {
      return invalidCursor();
    }

    return {
      ok: true,
      value: {
        timestamp: timestamp.value.canonical,
        id: payload.id as LogId,
      },
    };
  } catch {
    return invalidCursor();
  }
}
