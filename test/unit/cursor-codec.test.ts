import { describe, expect, it } from "vitest";

import type { CanonicalUtcTimestamp, LogId } from "../../src/domain/log-entry.js";
import { parseCanonicalTimestamp } from "../../src/domain/timestamp.js";
import {
  decodeLogCursor,
  encodeLogCursor,
  type LogCursorPosition,
} from "../../src/modules/query/cursor-codec.js";
import {
  parseLogFilters,
  parseLogListQuery,
  type LogFilters,
} from "../../src/modules/query/query-parameter-parser.js";

const INVALID_CURSOR = {
  ok: false,
  error: { error: "Query parameter 'cursor' is invalid." },
} as const;
const FIRST_ID = "00000000-0000-4000-8000-000000000001" as LogId;
const SECOND_ID = "00000000-0000-4000-8000-000000000002" as LogId;

interface TestPayload {
  readonly version: unknown;
  readonly timestamp: unknown;
  readonly id: unknown;
  readonly filterFingerprint: unknown;
}

function canonicalTimestamp(value: string): CanonicalUtcTimestamp {
  const result = parseCanonicalTimestamp(value);
  if (!result.ok) {
    throw new Error("The test fixture timestamp must be canonicalizable.");
  }

  return result.value.canonical;
}

function filters(overrides: Partial<LogFilters> = {}): LogFilters {
  return { attributes: [], ...overrides };
}

function parsedFilters(input: unknown): LogFilters {
  const result = parseLogFilters(input);
  if (!result.ok) {
    throw new Error("The test query must produce valid filters.");
  }

  return result.value;
}

function parsedListFilters(input: unknown): LogFilters {
  const result = parseLogListQuery(input);
  if (!result.ok) {
    throw new Error("The test query must produce a valid list query.");
  }

  return result.value.filters;
}

function position(
  timestamp = canonicalTimestamp("2026-08-10T12:30:00.1234Z"),
  id: LogId = FIRST_ID,
): LogCursorPosition {
  return { timestamp, id };
}

function tokenFromJson(json: string): string {
  return Buffer.from(json, "utf8").toString("base64url");
}

function payloadJson(payload: TestPayload): string {
  return JSON.stringify({
    version: payload.version,
    timestamp: payload.timestamp,
    id: payload.id,
    filterFingerprint: payload.filterFingerprint,
  });
}

function tokenFromPayload(payload: TestPayload): string {
  return tokenFromJson(payloadJson(payload));
}

function readPayload(cursor: string): TestPayload {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as TestPayload;
}

function expectInvalid(cursor: string, inputFilters: LogFilters = filters()): void {
  expect(decodeLogCursor(cursor, inputFilters)).toEqual(INVALID_CURSOR);
}

describe("cursor encoding and round trip", () => {
  it("round-trips an empty-filter cursor as canonical unpadded base64url", () => {
    const inputPosition = position();
    const cursor = encodeLogCursor(inputPosition, filters());

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(cursor).not.toContain("=");
    expect(decodeLogCursor(cursor, filters())).toEqual({ ok: true, value: inputPosition });
  });

  it("round-trips every filter and produces a lowercase SHA-256 fingerprint", () => {
    const inputFilters = filters({
      service: "checkout",
      level: "error",
      since: canonicalTimestamp("2026-08-10T12:00:00.000Z"),
      until: canonicalTimestamp("2026-08-10T13:00:00.000Z"),
      q: "Payment_%\\Declined",
      attributes: [
        { key: "enabled", value: "true" },
        { key: "retries", value: "3" },
      ],
    });
    const inputPosition = position();
    const cursor = encodeLogCursor(inputPosition, inputFilters);

    expect(readPayload(cursor).filterFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(decodeLogCursor(cursor, inputFilters)).toEqual({ ok: true, value: inputPosition });
  });

  it("is deterministic, does not mutate filters, and returns fresh decoded positions", () => {
    const attributes = Object.freeze([
      Object.freeze({ key: "z", value: "last" }),
      Object.freeze({ key: "a", value: "first" }),
    ]);
    const inputFilters = Object.freeze(filters({ service: "checkout", attributes }));
    const inputPosition = Object.freeze(position());

    const first = encodeLogCursor(inputPosition, inputFilters);
    const second = encodeLogCursor(inputPosition, inputFilters);
    const firstDecoded = decodeLogCursor(first, inputFilters);
    const secondDecoded = decodeLogCursor(second, inputFilters);

    expect(first).toBe(second);
    expect(inputFilters).toEqual({ service: "checkout", attributes });
    expect(firstDecoded).toEqual(secondDecoded);
    if (firstDecoded.ok && secondDecoded.ok) {
      expect(firstDecoded.value).not.toBe(secondDecoded.value);
    }
  });

  it("keeps equal-timestamp UUID positions distinct", () => {
    const timestamp = canonicalTimestamp("2026-08-10T12:30:00.000Z");
    const first = encodeLogCursor(position(timestamp, FIRST_ID), filters());
    const second = encodeLogCursor(position(timestamp, SECOND_ID), filters());

    expect(first).not.toBe(second);
    expect(decodeLogCursor(first, filters())).toEqual({
      ok: true,
      value: position(timestamp, FIRST_ID),
    });
    expect(decodeLogCursor(second, filters())).toEqual({
      ok: true,
      value: position(timestamp, SECOND_ID),
    });
  });
});

describe("canonical filter fingerprint", () => {
  it("sorts attribute tuples by code unit without mutating their input order", () => {
    const firstAttributes = [
      { key: "z", value: "last" },
      { key: "a", value: "second" },
      { key: "a", value: "first" },
    ];
    const secondAttributes = [
      { key: "a", value: "first" },
      { key: "z", value: "last" },
      { key: "a", value: "second" },
    ];
    const firstFilters = filters({ attributes: firstAttributes });
    const secondFilters = filters({ attributes: secondAttributes });

    expect(encodeLogCursor(position(), firstFilters)).toBe(
      encodeLogCursor(position(), secondFilters),
    );
    expect(firstAttributes.map((attribute) => attribute.value)).toEqual([
      "last",
      "second",
      "first",
    ]);
  });

  it("normalizes empty q identically to absent q", () => {
    expect(encodeLogCursor(position(), filters({ q: "" }))).toBe(
      encodeLogCursor(position(), filters()),
    );
  });

  it("uses the parser's canonical timestamp rather than its original offset spelling", () => {
    const first = parsedFilters({ since: "2026-08-10T14:00:00+02:00" });
    const second = parsedFilters({ since: "2026-08-10T07:00:00-05:00" });

    expect(encodeLogCursor(position(), first)).toBe(encodeLogCursor(position(), second));
  });

  it("excludes limit, cursor transport, and ignored unknown parameters", () => {
    const first = parsedListFilters({
      service: "checkout",
      limit: "1",
      cursor: "first-opaque-token",
      metadata: "ignored",
    });
    const second = parsedListFilters({
      service: "checkout",
      limit: "1000",
      cursor: "second-opaque-token",
      another_unknown: ["ignored", "twice"],
    });

    expect(encodeLogCursor(position(), first)).toBe(encodeLogCursor(position(), second));
  });

  it("preserves Unicode, whitespace, empty, backslash, JSON, and prototype-sensitive data", () => {
    const before = Object.getOwnPropertyDescriptor(Object.prototype, "polluted");
    const inputFilters = filters({
      service: " checkout ",
      q: "שלום\\世界",
      attributes: [
        { key: "__proto__", value: "prototype value" },
        { key: "constructor", value: "constructor value" },
        { key: "prototype", value: "" },
        { key: "toString", value: 'quote"\\value' },
      ],
    });
    const cursor = encodeLogCursor(position(), inputFilters);

    expect(decodeLogCursor(cursor, inputFilters)).toEqual({ ok: true, value: position() });
    expect(decodeLogCursor(cursor, filters({ ...inputFilters, q: "שלום\\world" }))).toEqual(
      INVALID_CURSOR,
    );
    expect(Object.getOwnPropertyDescriptor(Object.prototype, "polluted")).toEqual(before);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it.each([
    { name: "service", change: { service: "auth" } },
    { name: "level", change: { level: "warn" as const } },
    { name: "since", change: { since: canonicalTimestamp("2026-08-10T11:59:59.000Z") } },
    { name: "until", change: { until: canonicalTimestamp("2026-08-10T13:00:01.000Z") } },
    { name: "q", change: { q: "DECLINED" } },
    { name: "attribute key", change: { attributes: [{ key: "attempt", value: "3" }] } },
    { name: "attribute value", change: { attributes: [{ key: "retries", value: "4" }] } },
  ])("rejects reuse after changing $name", ({ change }) => {
    const original = filters({
      service: "checkout",
      level: "error",
      since: canonicalTimestamp("2026-08-10T12:00:00.000Z"),
      until: canonicalTimestamp("2026-08-10T13:00:00.000Z"),
      q: "declined",
      attributes: [{ key: "retries", value: "3" }],
    });
    const cursor = encodeLogCursor(position(), original);

    expect(decodeLogCursor(cursor, filters({ ...original, ...change }))).toEqual(INVALID_CURSOR);
  });

  it("keeps position timestamp and ID outside the filter fingerprint", () => {
    const inputFilters = filters({ service: "checkout" });
    const first = readPayload(encodeLogCursor(position(), inputFilters));
    const second = readPayload(
      encodeLogCursor(
        position(canonicalTimestamp("2026-08-10T12:31:00.000Z"), SECOND_ID),
        inputFilters,
      ),
    );

    expect(first.filterFingerprint).toBe(second.filterFingerprint);
  });
});

describe("strict base64url, UTF-8, and JSON boundaries", () => {
  it.each(["", " ", "+", "/", "YQ==", "Y Q", "*", "A"])(
    "rejects a non-canonical base64url token: %j",
    (cursor) => {
      expectInvalid(cursor);
    },
  );

  it("rejects bytes that are not valid UTF-8", () => {
    expectInvalid(Buffer.from([0xff, 0xfe, 0xfd]).toString("base64url"));
  });

  it("rejects a canonical base64url token whose UTF-8 bytes begin with a BOM", () => {
    const validCursor = encodeLogCursor(position(), filters());
    const prefixedBytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(validCursor, "base64url"),
    ]);

    expectInvalid(prefixedBytes.toString("base64url"));
  });

  it.each(["not JSON", "null", "[]", '"text"', "42", "true"])(
    "rejects a non-object JSON value: %s",
    (json) => {
      expectInvalid(tokenFromJson(json));
    },
  );

  it.each(["version", "timestamp", "id", "filterFingerprint"])(
    "rejects a payload missing $key",
    (key) => {
      const payload = readPayload(encodeLogCursor(position(), filters()));
      const entries = Object.entries(payload).filter(([name]) => name !== key);
      expectInvalid(tokenFromJson(JSON.stringify(Object.fromEntries(entries))));
    },
  );

  it.each(["extra", "__proto__", "constructor"])("rejects an extra $key field", (key) => {
    const canonical = payloadJson(readPayload(encodeLogCursor(position(), filters())));
    const json = `${canonical.slice(0, -1)},${JSON.stringify(key)}:"hostile"}`;
    expectInvalid(tokenFromJson(json));
  });

  it("rejects duplicate payload keys", () => {
    const payload = readPayload(encodeLogCursor(position(), filters()));
    const canonical = payloadJson(payload);
    const duplicate = canonical.replace('"version":1', '"version":1,"version":1');

    expectInvalid(tokenFromJson(duplicate));
  });

  it("rejects reordered payload keys", () => {
    const payload = readPayload(encodeLogCursor(position(), filters()));
    const reordered = JSON.stringify({
      timestamp: payload.timestamp,
      version: payload.version,
      id: payload.id,
      filterFingerprint: payload.filterFingerprint,
    });

    expectInvalid(tokenFromJson(reordered));
  });

  it("rejects JSON whitespace variants", () => {
    const payload = readPayload(encodeLogCursor(position(), filters()));
    expectInvalid(tokenFromJson(JSON.stringify(payload, null, 2)));
  });
});

describe("payload field validation and failure safety", () => {
  function validPayload(): TestPayload {
    return readPayload(encodeLogCursor(position(), filters()));
  }

  it.each([
    { name: "number 2", value: 2 },
    { name: "string 1", value: "1" },
  ])("rejects version $name", ({ value }) => {
    expectInvalid(tokenFromPayload({ ...validPayload(), version: value }));
  });

  it.each([
    "not-a-timestamp",
    "2026-02-30T12:00:00Z",
    "2026-08-10T12:30:00",
    "2026-08-10T14:30:00+02:00",
  ])("rejects invalid or non-canonical timestamp %j", (timestamp) => {
    expectInvalid(tokenFromPayload({ ...validPayload(), timestamp }));
  });

  it.each([
    "not-a-uuid",
    "00000000-0000-5000-8000-000000000001",
    "00000000-0000-4000-7000-000000000001",
    "00000000-0000-4000-8000-00000000000A",
  ])("rejects invalid UUID v4 %j", (id) => {
    expectInvalid(tokenFromPayload({ ...validPayload(), id }));
  });

  it.each([
    { name: "non-string", value: 42 },
    { name: "too short", value: "0".repeat(63) },
    { name: "non-hex", value: "g".repeat(64) },
    { name: "uppercase", value: "A".repeat(64) },
    { name: "valid hex mismatch", value: "0".repeat(64) },
  ])("rejects a $name fingerprint", ({ value }) => {
    expectInvalid(tokenFromPayload({ ...validPayload(), filterFingerprint: value }));
  });

  it("returns one fixed failure without reflecting hostile decoded content", () => {
    const hostile = "secret-database-url DROP TABLE logstream.logs";
    const result = decodeLogCursor(tokenFromJson(JSON.stringify({ hostile })), filters());

    expect(result).toEqual(INVALID_CURSOR);
    expect(JSON.stringify(result)).not.toContain("secret-database-url");
    expect(JSON.stringify(result)).not.toContain("DROP TABLE");
  });
});

describe("documented unsigned position behavior", () => {
  it("accepts a structurally valid changed timestamp when filters still match", () => {
    const inputFilters = filters({ service: "checkout" });
    const payload = readPayload(encodeLogCursor(position(), inputFilters));
    const changedTimestamp = canonicalTimestamp("2026-08-10T12:29:00.000Z");
    const changed = tokenFromPayload({ ...payload, timestamp: changedTimestamp });

    expect(decodeLogCursor(changed, inputFilters)).toEqual({
      ok: true,
      value: position(changedTimestamp, FIRST_ID),
    });
  });

  it("accepts a structurally valid changed UUID when filters still match", () => {
    const inputFilters = filters({ service: "checkout" });
    const payload = readPayload(encodeLogCursor(position(), inputFilters));
    const changed = tokenFromPayload({ ...payload, id: SECOND_ID });

    expect(decodeLogCursor(changed, inputFilters)).toEqual({
      ok: true,
      value: position(payload.timestamp as CanonicalUtcTimestamp, SECOND_ID),
    });
  });
});
