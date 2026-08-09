import { describe, expect, it, vi } from "vitest";

import type { ValidatedLogEntry } from "../../src/domain/log-entry.js";
import { LOG_LEVELS } from "../../src/domain/log-entry.js";
import { validateLogEntry } from "../../src/domain/log-entry-validator.js";

const REFERENCE_TIME_MS = Date.UTC(2026, 0, 15, 12, 0, 0, 0);
const VALID_TIMESTAMP = "2026-01-15T12:00:00.000Z";
const NUL = "\u0000";

const reasons = {
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
  serviceNul: "service must not contain U+0000",
  messageRequired: "message is required",
  messageString: "message must be a string",
  messageEmpty: "message must be non-empty",
  messageNul: "message must not contain U+0000",
  attributesObject: "attributes must be a non-null object",
  attributeKeyNul: "attribute keys must not contain U+0000",
  attributeValue: "attribute values must be strings, finite numbers, or booleans",
  attributeStringNul: "string attribute values must not contain U+0000",
} as const;

function validEntry(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    timestamp: VALID_TIMESTAMP,
    level: "info",
    service: "checkout",
    message: "payment accepted",
    ...overrides,
  };
}

function withoutField(field: string): Record<string, unknown> {
  const entry = validEntry();
  Reflect.deleteProperty(entry, field);
  return entry;
}

function expectSuccess(input: unknown, referenceTimeMs = REFERENCE_TIME_MS): ValidatedLogEntry {
  const result = validateLogEntry(input, referenceTimeMs);

  expect(result.ok).toBe(true);

  if (!result.ok) {
    throw new Error(`Expected validation success but received: ${result.reason}`);
  }

  expect(Object.keys(result.value)).toEqual([
    "timestamp",
    "level",
    "service",
    "message",
    "attributes",
  ]);

  return result.value;
}

function expectFailure(input: unknown, reason: string, referenceTimeMs = REFERENCE_TIME_MS): void {
  expect(validateLogEntry(input, referenceTimeMs)).toEqual({ ok: false, reason });
}

describe("validateLogEntry", () => {
  describe("entry shape", () => {
    it.each([
      { name: "null", input: null },
      { name: "an empty array", input: [] },
      { name: "an array containing an entry", input: [validEntry()] },
      { name: "a string", input: "entry" },
      { name: "a number", input: 42 },
      { name: "a boolean", input: true },
      { name: "undefined", input: undefined },
    ])("rejects $name", ({ input }) => {
      expectFailure(input, reasons.entryObject);
    });

    it("requires documented fields to be own properties", () => {
      const inheritedEntry: Record<string, unknown> = {};
      Object.setPrototypeOf(inheritedEntry, validEntry());

      expectFailure(inheritedEntry, reasons.timestampRequired);
    });

    it("accepts an ordinary object and returns the complete validated value", () => {
      const value = expectSuccess(validEntry());

      expect(value.timestamp).toBe(VALID_TIMESTAMP);
      expect(value.level).toBe("info");
      expect(value.service).toBe("checkout");
      expect(value.message).toBe("payment accepted");
      expect(Object.getPrototypeOf(value.attributes)).toBeNull();
      expect(Object.keys(value.attributes)).toEqual([]);
    });

    it("accepts a null-prototype entry", () => {
      const entry = Object.assign(Object.create(null) as Record<string, unknown>, validEntry());
      const value = expectSuccess(entry);

      expect(value.service).toBe("checkout");
      expect(value.message).toBe("payment accepted");
    });
  });

  describe("timestamp", () => {
    it("rejects a missing timestamp", () => {
      expectFailure(withoutField("timestamp"), reasons.timestampRequired);
    });

    it.each([null, 42, true, {}, []])("rejects the wrong timestamp type: %j", (timestamp) => {
      expectFailure(validEntry({ timestamp }), reasons.timestampString);
    });

    it.each([
      "not-a-timestamp",
      "2026-01-15",
      "2026-01-15T12:00:00",
      "2026-01-15 12:00:00Z",
      "2026-1-15T12:00:00Z",
      "2026-01-15T12:00Z",
      "2026-01-15T12:00:00.Z",
      "2026-01-15T12:00:00z",
    ])("rejects a timestamp outside the approved grammar: %s", (timestamp) => {
      expectFailure(validEntry({ timestamp }), reasons.timestampGrammar);
    });

    it.each([
      "2026-02-29T12:00:00Z",
      "2026-02-30T12:00:00Z",
      "2026-04-31T12:00:00Z",
      "2026-00-15T12:00:00Z",
      "2026-13-15T12:00:00Z",
      "2026-01-00T12:00:00Z",
    ])("rejects an invalid calendar date: %s", (timestamp) => {
      expectFailure(validEntry({ timestamp }), reasons.timestampComponents);
    });

    it.each([
      "2026-01-15T24:00:00Z",
      "2026-01-15T12:60:00Z",
      "2026-01-15T12:00:60Z",
      "2026-01-15T12:00:00+15:00",
      "2026-01-15T12:00:00+14:01",
      "2026-01-15T12:00:00-02:60",
    ])("rejects invalid time or offset components: %s", (timestamp) => {
      expectFailure(validEntry({ timestamp }), reasons.timestampComponents);
    });

    it("accepts a real leap day", () => {
      const value = expectSuccess(
        validEntry({ timestamp: "2024-02-29T12:00:00Z" }),
        Date.UTC(2024, 1, 29, 12, 0, 0),
      );

      expect(value.timestamp).toBe("2024-02-29T12:00:00.000Z");
    });

    it.each([
      {
        name: "Z timezone without a fractional part",
        input: "2026-01-15T12:00:00Z",
        expected: "2026-01-15T12:00:00.000Z",
      },
      {
        name: "one zero fractional digit",
        input: "2026-01-15T12:00:00.0Z",
        expected: "2026-01-15T12:00:00.000Z",
      },
      {
        name: "redundant zero digits beyond milliseconds",
        input: "2026-01-15T12:00:00.0000Z",
        expected: "2026-01-15T12:00:00.000Z",
      },
      {
        name: "one fractional digit",
        input: "2026-01-15T12:00:00.1Z",
        expected: "2026-01-15T12:00:00.100Z",
      },
      {
        name: "trailing zeros after a millisecond value",
        input: "2026-01-15T12:00:00.1200Z",
        expected: "2026-01-15T12:00:00.120Z",
      },
      {
        name: "millisecond fraction",
        input: "2026-01-15T12:00:00.123Z",
        expected: "2026-01-15T12:00:00.123Z",
      },
      {
        name: "significant sub-millisecond digit with trailing zeros",
        input: "2026-01-15T12:00:00.123400Z",
        expected: "2026-01-15T12:00:00.1234Z",
      },
      {
        name: "leading-zero significant sub-millisecond digit",
        input: "2026-01-15T12:00:00.000100Z",
        expected: "2026-01-15T12:00:00.0001Z",
      },
      {
        name: "sub-millisecond fractional precision",
        input: "2026-01-15T12:00:00.123456Z",
        expected: "2026-01-15T12:00:00.123456Z",
      },
      {
        name: "positive offset",
        input: "2026-01-15T14:00:00+02:00",
        expected: "2026-01-15T12:00:00.000Z",
      },
      {
        name: "negative offset",
        input: "2026-01-15T07:00:00-05:00",
        expected: "2026-01-15T12:00:00.000Z",
      },
    ])("accepts and normalizes $name", ({ input, expected }) => {
      const value = expectSuccess(validEntry({ timestamp: input }));

      expect(value.timestamp).toBe(expected);
    });

    it("accepts exactly five minutes in the future", () => {
      const timestamp = "2026-01-15T12:05:00.000Z";
      const value = expectSuccess(validEntry({ timestamp }));

      expect(value.timestamp).toBe(timestamp);
    });

    it("accepts an arbitrarily long all-zero tail at the exact future boundary", () => {
      const timestamp = `2026-01-15T12:05:00.${"0".repeat(500)}Z`;
      const value = expectSuccess(validEntry({ timestamp }));

      expect(value.timestamp).toBe("2026-01-15T12:05:00.000Z");
    });

    it("rejects one millisecond beyond five minutes in the future", () => {
      expectFailure(validEntry({ timestamp: "2026-01-15T12:05:00.001Z" }), reasons.timestampFuture);
    });

    it("rejects a sub-millisecond fraction beyond five minutes in the future", () => {
      expectFailure(
        validEntry({ timestamp: "2026-01-15T12:05:00.0001Z" }),
        reasons.timestampFuture,
      );
    });

    it("rejects a nonzero digit after hundreds of zeros beyond the future boundary", () => {
      const timestamp = `2026-01-15T12:05:00.${"0".repeat(500)}1Z`;

      expectFailure(validEntry({ timestamp }), reasons.timestampFuture);
    });

    it("accepts a very old valid timestamp", () => {
      const value = expectSuccess(validEntry({ timestamp: "1970-01-01T00:00:00Z" }));

      expect(value.timestamp).toBe("1970-01-01T00:00:00.000Z");
    });

    it("does not read Date.now", () => {
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
        throw new Error("Date.now must not be called");
      });

      const value = expectSuccess(validEntry());

      expect(value.timestamp).toBe(VALID_TIMESTAMP);
      expect(nowSpy).not.toHaveBeenCalled();
    });
  });

  describe("level", () => {
    it.each(LOG_LEVELS)("accepts the exact %s level", (level) => {
      const value = expectSuccess(validEntry({ level }));

      expect(value.level).toBe(level);
    });

    it("rejects a missing level", () => {
      expectFailure(withoutField("level"), reasons.levelRequired);
    });

    it.each([null, 42, true, {}, []])("rejects the wrong level type: %j", (level) => {
      expectFailure(validEntry({ level }), reasons.levelString);
    });

    it.each(["", "critical", "INFO", "Info", " error "])(
      "rejects an unsupported or non-exact level: %j",
      (level) => {
        expectFailure(validEntry({ level }), reasons.levelValue);
      },
    );
  });

  describe("service and message", () => {
    it.each([
      { field: "service", reason: reasons.serviceRequired },
      { field: "message", reason: reasons.messageRequired },
    ])("rejects a missing $field", ({ field, reason }) => {
      expectFailure(withoutField(field), reason);
    });

    it.each([
      { field: "service", value: null, reason: reasons.serviceString },
      { field: "service", value: 42, reason: reasons.serviceString },
      { field: "service", value: {}, reason: reasons.serviceString },
      { field: "message", value: null, reason: reasons.messageString },
      { field: "message", value: false, reason: reasons.messageString },
      { field: "message", value: [], reason: reasons.messageString },
    ])("rejects a non-string $field", ({ field, value, reason }) => {
      expectFailure(validEntry({ [field]: value }), reason);
    });

    it.each([
      { field: "service", reason: reasons.serviceEmpty },
      { field: "message", reason: reasons.messageEmpty },
    ])("rejects an empty $field", ({ field, reason }) => {
      expectFailure(validEntry({ [field]: "" }), reason);
    });

    it.each([
      { field: "service", value: NUL, reason: reasons.serviceNul },
      { field: "service", value: `check${NUL}out`, reason: reasons.serviceNul },
      { field: "message", value: NUL, reason: reasons.messageNul },
      { field: "message", value: `payment${NUL}accepted`, reason: reasons.messageNul },
    ])("rejects U+0000 in $field without echoing its value", ({ field, value, reason }) => {
      expectFailure(validEntry({ [field]: value }), reason);
    });

    it("accepts and preserves whitespace-only strings", () => {
      const value = expectSuccess(validEntry({ service: "   ", message: "\t" }));

      expect(value.service).toBe("   ");
      expect(value.message).toBe("\t");
    });

    it("preserves leading and trailing whitespace", () => {
      const value = expectSuccess(
        validEntry({ service: " checkout ", message: " payment accepted " }),
      );

      expect(value.service).toBe(" checkout ");
      expect(value.message).toBe(" payment accepted ");
    });

    it.each([
      { name: "U+0001", character: "\u0001" },
      { name: "tab", character: "\t" },
      { name: "newline", character: "\n" },
      { name: "carriage return", character: "\r" },
    ])("does not treat $name as U+0000", ({ character }) => {
      const value = expectSuccess(
        validEntry({
          service: `service${character}name`,
          message: `message${character}value`,
          attributes: { [`key${character}`]: `value${character}` },
        }),
      );

      expect(value.service).toBe(`service${character}name`);
      expect(value.message).toBe(`message${character}value`);
      expect(value.attributes[`key${character}`]).toBe(`value${character}`);
    });
  });

  describe("attributes", () => {
    it("turns omitted attributes into an empty null-prototype object", () => {
      const value = expectSuccess(validEntry());

      expect(Object.getPrototypeOf(value.attributes)).toBeNull();
      expect(Object.keys(value.attributes)).toEqual([]);
    });

    it("copies an empty object into a distinct null-prototype object", () => {
      const inputAttributes = {};
      const value = expectSuccess(validEntry({ attributes: inputAttributes }));

      expect(value.attributes).not.toBe(inputAttributes);
      expect(Object.getPrototypeOf(value.attributes)).toBeNull();
      expect(Object.keys(value.attributes)).toEqual([]);
    });

    it("preserves string, finite-number, and boolean values", () => {
      const inputAttributes = {
        user_id: "42",
        retries: 3,
        ratio: 1.25,
        enabled: true,
        cached: false,
      };
      const value = expectSuccess(validEntry({ attributes: inputAttributes }));

      expect(value.attributes["user_id"]).toBe("42");
      expect(value.attributes["retries"]).toBe(3);
      expect(value.attributes["ratio"]).toBe(1.25);
      expect(value.attributes["enabled"]).toBe(true);
      expect(value.attributes["cached"]).toBe(false);
      expect(Object.getPrototypeOf(value.attributes)).toBeNull();
    });

    it.each([null, [], "attributes", 42, true])(
      "rejects an invalid attribute container: %j",
      (attributes) => {
        expectFailure(validEntry({ attributes }), reasons.attributesObject);
      },
    );

    it.each([
      { name: "a nested object", value: { nested: true } },
      { name: "an array", value: ["nested"] },
      { name: "null", value: null },
      { name: "NaN", value: Number.NaN },
      { name: "positive infinity", value: Number.POSITIVE_INFINITY },
      { name: "negative infinity", value: Number.NEGATIVE_INFINITY },
    ])("rejects $name as an attribute value", ({ value }) => {
      expectFailure(validEntry({ attributes: { unsafe: value } }), reasons.attributeValue);
    });

    it("rejects a non-empty attribute key containing U+0000", () => {
      expectFailure(
        validEntry({ attributes: { [`request${NUL}id`]: "value" } }),
        reasons.attributeKeyNul,
      );
    });

    it("rejects a string attribute value containing U+0000", () => {
      expectFailure(
        validEntry({ attributes: { request_id: `abc${NUL}def` } }),
        reasons.attributeStringNul,
      );
    });

    it("checks an attribute key before validating that entry's value", () => {
      expectFailure(
        validEntry({ attributes: { [`unsafe${NUL}key`]: { nested: true } } }),
        reasons.attributeKeyNul,
      );
    });

    it("preserves negative zero at the validation stage", () => {
      const value = expectSuccess(validEntry({ attributes: { balance: -0 } }));

      expect(Object.is(value.attributes["balance"], -0)).toBe(true);
    });

    it("preserves empty, Unicode, and JavaScript-sensitive keys and values safely", () => {
      const inputAttributes = Object.create(null) as Record<string, unknown>;
      inputAttributes[""] = "empty";
      inputAttributes["地域"] = "שלום 世界";
      inputAttributes["__proto__"] = "prototype value";
      Object.defineProperty(inputAttributes, "constructor", {
        value: "constructor value",
        enumerable: true,
      });

      const value = expectSuccess(validEntry({ attributes: inputAttributes }));

      expect(Object.getPrototypeOf(value.attributes)).toBeNull();
      expect(Object.keys(value.attributes)).toEqual(["", "地域", "__proto__", "constructor"]);
      expect(Object.hasOwn(value.attributes, "")).toBe(true);
      expect(Object.hasOwn(value.attributes, "地域")).toBe(true);
      expect(Object.hasOwn(value.attributes, "__proto__")).toBe(true);
      expect(Object.hasOwn(value.attributes, "constructor")).toBe(true);
      expect(value.attributes[""]).toBe("empty");
      expect(value.attributes["地域"]).toBe("שלום 世界");
      expect(value.attributes["__proto__"]).toBe("prototype value");
      expect(Reflect.get(value.attributes, "constructor")).toBe("constructor value");
    });

    it("ignores inherited attribute properties without evaluating them", () => {
      const prototype = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(prototype, "inherited", {
        enumerable: true,
        get: () => {
          throw new Error("inherited attributes must not be read");
        },
      });
      const inputAttributes = Object.create(prototype) as Record<string, unknown>;
      inputAttributes["own"] = "kept";

      const value = expectSuccess(validEntry({ attributes: inputAttributes }));

      expect(Object.keys(value.attributes)).toEqual(["own"]);
      expect(value.attributes["own"]).toBe("kept");
      expect(Object.hasOwn(value.attributes, "inherited")).toBe(false);
    });

    it("does not mutate or reuse the caller's entry or attributes", () => {
      const inputAttributes = Object.freeze({ request_id: "abc" });
      const input = Object.freeze(validEntry({ attributes: inputAttributes }));

      const value = expectSuccess(input);

      expect(input).toEqual({
        timestamp: VALID_TIMESTAMP,
        level: "info",
        service: "checkout",
        message: "payment accepted",
        attributes: { request_id: "abc" },
      });
      expect(value.attributes).not.toBe(inputAttributes);
      expect(value.attributes["request_id"]).toBe("abc");
    });

    it("does not mutate rejected entry or attribute objects", () => {
      const inputAttributes = Object.freeze({ request_id: `abc${NUL}def` });
      const input = Object.freeze(validEntry({ attributes: inputAttributes }));

      expectFailure(input, reasons.attributeStringNul);
      expect(input["attributes"]).toBe(inputAttributes);
      expect(inputAttributes.request_id).toBe(`abc${NUL}def`);
    });
  });

  describe("unknown fields", () => {
    it("ignores a harmless unknown scalar field", () => {
      const value = expectSuccess(validEntry({ metadata: "ignored" }));

      expect(Object.keys(value)).toEqual([
        "timestamp",
        "level",
        "service",
        "message",
        "attributes",
      ]);
      expect("metadata" in value).toBe(false);
    });

    it("ignores an unknown field containing U+0000", () => {
      const value = expectSuccess(validEntry({ metadata: `ignored${NUL}value` }));

      expect(value.service).toBe("checkout");
      expect("metadata" in value).toBe(false);
    });

    it("ignores a large or complex unknown value semantically", () => {
      const complexUnknown: Record<string, unknown> = {
        nested: { values: Array.from({ length: 1_000 }, (_, index) => index) },
      };
      complexUnknown["self"] = complexUnknown;

      const value = expectSuccess(validEntry({ extra: complexUnknown }));

      expect(value.service).toBe("checkout");
      expect("extra" in value).toBe(false);
    });
  });

  describe("determinism", () => {
    it.each([
      {
        name: "entry shape before every field",
        input: null,
        reason: reasons.entryObject,
      },
      {
        name: "timestamp before level",
        input: { level: "critical", service: "", message: "", attributes: null },
        reason: reasons.timestampRequired,
      },
      {
        name: "level before service",
        input: validEntry({ level: "critical", service: "", message: "", attributes: null }),
        reason: reasons.levelValue,
      },
      {
        name: "service before message",
        input: validEntry({ service: "", message: "", attributes: null }),
        reason: reasons.serviceEmpty,
      },
      {
        name: "service U+0000 before message",
        input: validEntry({ service: NUL, message: "", attributes: null }),
        reason: reasons.serviceNul,
      },
      {
        name: "message before attributes",
        input: validEntry({ message: "", attributes: null }),
        reason: reasons.messageEmpty,
      },
      {
        name: "message U+0000 before attributes",
        input: validEntry({ message: NUL, attributes: null }),
        reason: reasons.messageNul,
      },
      {
        name: "attributes last",
        input: validEntry({ attributes: null }),
        reason: reasons.attributesObject,
      },
    ])("checks $name", ({ input, reason }) => {
      expectFailure(input, reason);
    });

    it("returns equivalent results for identical input and reference time", () => {
      const input = validEntry({ attributes: { request_id: `abc${NUL}def` } });

      const first = validateLogEntry(input, REFERENCE_TIME_MS);
      const second = validateLogEntry(input, REFERENCE_TIME_MS);

      expect(second).toEqual(first);
      expect(first).toEqual({ ok: false, reason: reasons.attributeStringNul });
    });
  });
});
