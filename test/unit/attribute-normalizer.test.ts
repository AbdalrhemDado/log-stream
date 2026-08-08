import { describe, expect, it } from "vitest";

import { normalizeAttributes } from "../../src/domain/attribute-normalizer.js";
import type { OriginalAttributes } from "../../src/domain/attributes.js";
import { validateLogEntry } from "../../src/domain/log-entry-validator.js";

const REFERENCE_TIME_MS = Date.UTC(2026, 0, 15, 12, 0, 0, 0);
const INVALID_ATTRIBUTE_VALUE_MESSAGE = "Original attributes contain an unsupported runtime value.";

function validatedAttributes(values?: object): OriginalAttributes {
  const input: Record<string, unknown> = {
    timestamp: "2026-01-15T12:00:00Z",
    level: "info",
    service: "checkout",
    message: "payment accepted",
  };

  if (values !== undefined) {
    input["attributes"] = values;
  }

  const result = validateLogEntry(input, REFERENCE_TIME_MS);

  if (!result.ok) {
    throw new Error(`Test attributes failed validation: ${result.reason}`);
  }

  return result.value.attributes;
}

function forgedAttributes(value: unknown): OriginalAttributes {
  const forged = Object.create(null) as Record<string, unknown>;
  forged["unsafe"] = value;
  return forged as unknown as OriginalAttributes;
}

describe("normalizeAttributes", () => {
  describe("strings", () => {
    it.each([
      { name: "ordinary text", value: "checkout" },
      { name: "an empty string", value: "" },
      { name: "whitespace", value: "  \t" },
      { name: "Unicode", value: "שלום 世界" },
      { name: "a numeric-looking string", value: "42" },
      { name: "a true-looking string", value: "true" },
      { name: "a false-looking string", value: "false" },
    ])("preserves $name unchanged", ({ value }) => {
      const original = validatedAttributes({ value });
      const normalized = normalizeAttributes(original);

      expect(normalized["value"]).toBe(value);
      expect(original["value"]).toBe(value);
      expect(typeof original["value"]).toBe("string");
    });
  });

  describe("booleans", () => {
    it.each([
      { input: true, expected: "true" },
      { input: false, expected: "false" },
    ])("normalizes $input to $expected", ({ input, expected }) => {
      const original = validatedAttributes({ value: input });
      const normalized = normalizeAttributes(original);

      expect(normalized["value"]).toBe(expected);
      expect(original["value"]).toBe(input);
      expect(typeof original["value"]).toBe("boolean");
    });
  });

  describe("numbers", () => {
    it.each([
      { name: "zero", input: 0, expected: "0" },
      { name: "negative zero", input: -0, expected: "0" },
      { name: "a positive integer", input: 42, expected: "42" },
      { name: "a negative integer", input: -42, expected: "-42" },
      { name: "a positive decimal", input: 1.25, expected: "1.25" },
      { name: "a negative decimal", input: -1.25, expected: "-1.25" },
      {
        name: "Number.MAX_SAFE_INTEGER",
        input: Number.MAX_SAFE_INTEGER,
        expected: "9007199254740991",
      },
      {
        name: "the next representable integer beyond the safe boundary",
        input: Number.MAX_SAFE_INTEGER + 1,
        expected: "9007199254740992",
      },
      {
        name: "Number.MAX_VALUE",
        input: Number.MAX_VALUE,
        expected: "1.7976931348623157e+308",
      },
      { name: "Number.MIN_VALUE", input: Number.MIN_VALUE, expected: "5e-324" },
      { name: "the 1e21 exponential boundary", input: 1e21, expected: "1e+21" },
      { name: "the 1e-7 exponential boundary", input: 1e-7, expected: "1e-7" },
      { name: "the 1e-6 decimal boundary", input: 1e-6, expected: "0.000001" },
    ])("uses JSON/ECMAScript serialization for $name", ({ input, expected }) => {
      const original = validatedAttributes({ value: input });
      const normalized = normalizeAttributes(original);

      expect(normalized["value"]).toBe(expected);
      expect(Object.is(original["value"], input)).toBe(true);
      expect(typeof original["value"]).toBe("number");
    });
  });

  describe("prototype and mutation safety", () => {
    it("returns a distinct empty null-prototype object for empty input", () => {
      const original = validatedAttributes();
      const normalized = normalizeAttributes(original);

      expect(normalized).not.toBe(original);
      expect(Object.getPrototypeOf(normalized)).toBeNull();
      expect(Object.keys(normalized)).toEqual([]);
      expect(Object.keys(original)).toEqual([]);
    });

    it("preserves empty, Unicode, and JavaScript-sensitive keys exactly", () => {
      const values = Object.create(null) as Record<string, unknown>;
      values[""] = "empty";
      values["e\u0301"] = "decomposed";
      values["__proto__"] = "prototype value";
      Object.defineProperty(values, "constructor", {
        value: "constructor value",
        enumerable: true,
      });
      const original = validatedAttributes(values);
      const normalized = normalizeAttributes(original);

      expect(Object.getPrototypeOf(normalized)).toBeNull();
      expect(Object.keys(normalized)).toEqual(["", "e\u0301", "__proto__", "constructor"]);
      expect(Object.hasOwn(normalized, "")).toBe(true);
      expect(Object.hasOwn(normalized, "e\u0301")).toBe(true);
      expect(Object.hasOwn(normalized, "é")).toBe(false);
      expect(Object.hasOwn(normalized, "__proto__")).toBe(true);
      expect(Object.hasOwn(normalized, "constructor")).toBe(true);
      expect(normalized["__proto__"]).toBe("prototype value");
      expect(Reflect.get(normalized, "constructor")).toBe("constructor value");
    });

    it("ignores inherited enumerable properties", () => {
      const prototype = Object.create(null) as Record<string, unknown>;
      prototype["inherited"] = "ignored";
      const forged = Object.create(prototype) as Record<string, unknown>;
      forged["own"] = true;

      const normalized = normalizeAttributes(forged as unknown as OriginalAttributes);

      expect(Object.keys(normalized)).toEqual(["own"]);
      expect(normalized["own"]).toBe("true");
      expect(Object.hasOwn(normalized, "inherited")).toBe(false);
    });

    it("normalizes mixed values without mutating their original values or types", () => {
      const original = validatedAttributes({
        text: "42",
        count: 42,
        enabled: true,
        disabled: false,
        negativeZero: -0,
      });
      Object.freeze(original);

      const normalized = normalizeAttributes(original);

      expect(normalized).toEqual({
        text: "42",
        count: "42",
        enabled: "true",
        disabled: "false",
        negativeZero: "0",
      });
      expect(Object.getPrototypeOf(normalized)).toBeNull();
      expect(original["text"]).toBe("42");
      expect(original["count"]).toBe(42);
      expect(original["enabled"]).toBe(true);
      expect(original["disabled"]).toBe(false);
      expect(Object.is(original["negativeZero"], -0)).toBe(true);
      expect(typeof original["text"]).toBe("string");
      expect(typeof original["count"]).toBe("number");
      expect(typeof original["enabled"]).toBe("boolean");
    });

    it("returns equivalent but separate output objects on repeated calls", () => {
      const original = validatedAttributes({ text: "value", count: 3, enabled: true });

      const first = normalizeAttributes(original);
      const second = normalizeAttributes(original);

      expect(second).toEqual(first);
      expect(second).not.toBe(first);
      expect(first).not.toBe(original);
      expect(second).not.toBe(original);
    });
  });

  describe("defensive invariant handling", () => {
    it.each([
      { name: "NaN", value: Number.NaN },
      { name: "positive infinity", value: Number.POSITIVE_INFINITY },
      { name: "negative infinity", value: Number.NEGATIVE_INFINITY },
      { name: "null", value: null },
      { name: "an object", value: { nested: true } },
      { name: "an array", value: ["nested"] },
    ])("rejects forged $name values", ({ value }) => {
      const attributes = forgedAttributes(value);

      expect(() => normalizeAttributes(attributes)).toThrow(TypeError);
      expect(() => normalizeAttributes(attributes)).toThrow(INVALID_ATTRIBUTE_VALUE_MESSAGE);
    });
  });
});
