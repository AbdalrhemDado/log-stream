import { describe, expect, it } from "vitest";

import type {
  LogFilters,
  ParsedLogListQuery,
} from "../../src/modules/query/query-parameter-parser.js";
import {
  parseLogFilters,
  parseLogListQuery,
} from "../../src/modules/query/query-parameter-parser.js";

const NUL = "\u0000";

const errors = {
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

function expectFilterSuccess(input: unknown): LogFilters {
  const result = parseLogFilters(input);

  expect(result.ok).toBe(true);

  if (!result.ok) {
    throw new Error(`Expected filter success but received: ${result.error.error}`);
  }

  return result.value;
}

function expectListSuccess(input: unknown): ParsedLogListQuery {
  const result = parseLogListQuery(input);

  expect(result.ok).toBe(true);

  if (!result.ok) {
    throw new Error(`Expected list-query success but received: ${result.error.error}`);
  }

  return result.value;
}

function expectFilterFailure(input: unknown, error: string): void {
  expect(parseLogFilters(input)).toEqual({ ok: false, error: { error } });
}

function expectListFailure(input: unknown, error: string): void {
  expect(parseLogListQuery(input)).toEqual({ ok: false, error: { error } });
}

describe("query parameter container", () => {
  it.each([null, undefined, [], "service=checkout", 42, true])(
    "rejects an invalid query container: %j",
    (input) => {
      expectListFailure(input, errors.queryObject);
    },
  );

  it("returns normalized defaults for an empty query", () => {
    const value = expectListSuccess({});

    expect(value).toEqual({ filters: { attributes: [] }, limit: 100 });
    expect(Object.keys(value.filters)).toEqual(["attributes"]);
    expect(Object.hasOwn(value.filters, "service")).toBe(false);
    expect(Object.hasOwn(value.filters, "level")).toBe(false);
    expect(Object.hasOwn(value.filters, "since")).toBe(false);
    expect(Object.hasOwn(value.filters, "until")).toBe(false);
    expect(Object.hasOwn(value.filters, "q")).toBe(false);
    expect(Object.hasOwn(value, "cursor")).toBe(false);
  });

  it("accepts a null-prototype query object", () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, {
      service: "checkout",
      limit: "25",
    });

    expect(expectListSuccess(input)).toEqual({
      filters: { attributes: [], service: "checkout" },
      limit: 25,
    });
  });

  it("ignores inherited recognized properties", () => {
    const input = Object.create({ service: "inherited", limit: "1" }) as Record<string, unknown>;

    expect(expectListSuccess(input)).toEqual({ filters: { attributes: [] }, limit: 100 });
  });

  it("does not evaluate an unknown accessor", () => {
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "metadata", {
      enumerable: true,
      get: () => {
        throw new Error("unknown query parameters must not be evaluated");
      },
    });

    expect(expectListSuccess(input)).toEqual({ filters: { attributes: [] }, limit: 100 });
  });

  it("ignores non-enumerable recognized-looking properties", () => {
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "service", { enumerable: false, value: "hidden" });
    Object.defineProperty(input, "attr.hidden", { enumerable: false, value: "hidden" });

    expect(expectListSuccess(input)).toEqual({ filters: { attributes: [] }, limit: 100 });
  });
});

describe("combined normalized model", () => {
  it("parses every list parameter and sorts attributes by code unit", () => {
    const input = Object.create(null) as Record<string, unknown>;
    input["attr.地域"] = "中東";
    input["attr.a"] = "1";
    input["attr.__proto__"] = "prototype value";
    input["service"] = " checkout ";
    input["level"] = "error";
    input["since"] = "2026-01-15T14:00:00+02:00";
    input["until"] = "2026-01-15T13:00:00Z";
    input["q"] = "Payment_%\\Declined";
    input["limit"] = "0500";
    input["cursor"] = "opaque-token";
    input["metadata"] = ["ignored", "twice"];

    expect(expectListSuccess(input)).toEqual({
      filters: {
        attributes: [
          { key: "__proto__", value: "prototype value" },
          { key: "a", value: "1" },
          { key: "地域", value: "中東" },
        ],
        service: " checkout ",
        level: "error",
        since: "2026-01-15T12:00:00.000Z",
        until: "2026-01-15T13:00:00.000Z",
        q: "Payment_%\\Declined",
      },
      limit: 500,
      cursor: "opaque-token",
    });
  });

  it("does not mutate or reuse the caller's object or repeated-value arrays", () => {
    const ignoredValues = Object.freeze(["first", "second"]);
    const input = Object.freeze({
      service: "checkout",
      "attr.request_id": "abc",
      metadata: ignoredValues,
    });

    const value = expectListSuccess(input);

    expect(input).toEqual({
      service: "checkout",
      "attr.request_id": "abc",
      metadata: ["first", "second"],
    });
    expect(value.filters).not.toBe(input);
    expect(value.filters.attributes).not.toBe(ignoredValues);
  });
});

describe("service and level", () => {
  it.each(["", "   ", " Checkout ", "地域", "service\u0001name"])(
    "preserves the exact service string: %j",
    (service) => {
      expect(expectFilterSuccess({ service }).service).toBe(service);
    },
  );

  it.each(["debug", "info", "warn", "error"])("accepts the exact %s level", (level) => {
    expect(expectFilterSuccess({ level }).level).toBe(level);
  });

  it.each(["", "INFO", "Info", "critical", " error "])(
    "rejects an unsupported level: %j",
    (level) => {
      expectFilterFailure({ level }, errors.levelValue);
    },
  );

  it.each([
    { key: "service", value: 42, error: errors.serviceString },
    { key: "level", value: true, error: errors.levelString },
  ])("rejects a non-string $key", ({ key, value, error }) => {
    expectFilterFailure({ [key]: value }, error);
  });

  it("rejects U+0000 in service without reflecting the value", () => {
    expectFilterFailure({ service: `check${NUL}out` }, errors.serviceNul);
  });
});

describe("timestamps and ranges", () => {
  it.each([
    {
      key: "since",
      input: "2026-01-15T14:00:00.123400+02:00",
      expected: "2026-01-15T12:00:00.1234Z",
    },
    {
      key: "until",
      input: "2099-01-15T07:00:00-05:00",
      expected: "2099-01-15T12:00:00.000Z",
    },
  ])("normalizes $key and permits future ranges", ({ key, input, expected }) => {
    const value = expectFilterSuccess({ [key]: input });

    expect(value[key as "since" | "until"]).toBe(expected);
  });

  it.each([
    { key: "since", value: 42, error: errors.sinceTimestamp },
    { key: "until", value: {}, error: errors.untilTimestamp },
    { key: "since", value: "not-a-timestamp", error: errors.sinceTimestamp },
    { key: "until", value: "2026-02-30T12:00:00Z", error: errors.untilTimestamp },
    { key: "since", value: "2026-01-15T12:00:00", error: errors.sinceTimestamp },
    { key: "until", value: "2026-01-15T12:00:00+14:01", error: errors.untilTimestamp },
  ])("rejects invalid $key input", ({ key, value, error }) => {
    expectFilterFailure({ [key]: value }, error);
  });

  it("accepts equal offset-equivalent bounds as an empty half-open range", () => {
    expect(
      expectFilterSuccess({
        since: "2026-01-15T14:00:00+02:00",
        until: "2026-01-15T07:00:00-05:00",
      }),
    ).toMatchObject({
      since: "2026-01-15T12:00:00.000Z",
      until: "2026-01-15T12:00:00.000Z",
    });
  });

  it("rejects an until bound one significant sub-millisecond digit earlier", () => {
    expectFilterFailure(
      {
        since: "2026-01-15T12:00:00.0001001Z",
        until: "2026-01-15T12:00:00.0001Z",
      },
      errors.range,
    );
  });
});

describe("attribute filters", () => {
  it("combines distinct keys and preserves string values without coercion", () => {
    const value = expectFilterSuccess({
      "attr.boolean": "true",
      "attr.empty": "",
      "attr.leading": "01",
      "attr.negative_zero": "-0",
    });

    expect(value.attributes).toEqual([
      { key: "boolean", value: "true" },
      { key: "empty", value: "" },
      { key: "leading", value: "01" },
      { key: "negative_zero", value: "-0" },
    ]);
  });

  it("rejects bare attr. but accepts a non-empty key beginning with a dot", () => {
    expectFilterFailure({ "attr.": "value" }, errors.attributeKey);
    expect(expectFilterSuccess({ "attr..name": "value" }).attributes).toEqual([
      { key: ".name", value: "value" },
    ]);
  });

  it.each([{ value: 42 }, { value: true }, { value: null }, { value: {} }])(
    "rejects a non-string attribute value: $value",
    ({ value }) => {
      expectFilterFailure({ "attr.key": value }, errors.attributeString);
    },
  );

  it.each([{ value: ["first", "second"] }, { value: ["same", "same"] }, { value: ["single"] }])(
    "rejects a repeated same-key attribute represented as $value",
    ({ value }) => {
      expectFilterFailure({ "attr.key": value }, errors.attributeDuplicate);
    },
  );

  it("rejects U+0000 in attribute keys before inspecting the value", () => {
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, `attr.unsafe${NUL}key`, {
      enumerable: true,
      get: () => {
        throw new Error("a NUL-invalid key must fail before its value is read");
      },
    });

    expectFilterFailure(input, errors.attributeKeyNul);
  });

  it("rejects U+0000 in an attribute value", () => {
    expectFilterFailure({ "attr.key": `unsafe${NUL}value` }, errors.attributeValueNul);
  });

  it("accepts U+0001 and prototype-sensitive keys without pollution", () => {
    const before = Object.getOwnPropertyDescriptor(Object.prototype, "polluted");
    const input = Object.create(null) as Record<string, unknown>;
    input["attr.__proto__"] = "prototype value";
    input["attr.constructor"] = "constructor value";
    input["attr.prototype"] = "prototype key";
    input["attr.toString"] = "string key";
    input["attr.control\u0001key"] = "control\u0001value";

    expect(expectFilterSuccess(input).attributes).toEqual([
      { key: "__proto__", value: "prototype value" },
      { key: "constructor", value: "constructor value" },
      { key: "control\u0001key", value: "control\u0001value" },
      { key: "prototype", value: "prototype key" },
      { key: "toString", value: "string key" },
    ]);
    expect(Object.getOwnPropertyDescriptor(Object.prototype, "polluted")).toEqual(before);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
});

describe("q normalization", () => {
  it("normalizes empty q identically to absent q", () => {
    expect(expectFilterSuccess({ q: "" })).toEqual(expectFilterSuccess({}));
    expect(Object.hasOwn(expectFilterSuccess({ q: "" }), "q")).toBe(false);
  });

  it.each(["   ", "Declined", "%_\\", "' OR TRUE --", "שלום\u0001世界"])(
    "preserves a non-empty literal q value: %j",
    (q) => {
      expect(expectFilterSuccess({ q }).q).toBe(q);
    },
  );

  it("rejects U+0000 in q", () => {
    expectFilterFailure({ q: `declined${NUL}` }, errors.qNul);
  });
});

describe("limit and cursor", () => {
  it.each([
    { input: "1", expected: 1 },
    { input: "0001", expected: 1 },
    { input: "100", expected: 100 },
    { input: "1000", expected: 1000 },
  ])("parses limit $input as $expected", ({ input, expected }) => {
    expect(expectListSuccess({ limit: input }).limit).toBe(expected);
  });

  it.each([
    "",
    "0",
    "1001",
    "-1",
    "+1",
    "1.0",
    "1e2",
    "0x10",
    " 1",
    "1 ",
    "10abc",
    "9007199254740993",
    "9".repeat(500),
  ])("rejects invalid limit spelling or bounds: %j", (limit) => {
    expectListFailure({ limit }, errors.limitValue);
  });

  it.each([42, true, {}, null])("rejects a non-string limit: %j", (limit) => {
    expectListFailure({ limit }, errors.limitValue);
  });

  it("preserves a non-empty cursor as opaque transport data", () => {
    expect(expectListSuccess({ cursor: "not-yet-decoded" }).cursor).toBe("not-yet-decoded");
  });

  it.each(["", 42, {}, null])("rejects an invalid cursor transport value: %j", (cursor) => {
    expectListFailure({ cursor }, errors.cursorValue);
  });
});

describe("duplicates", () => {
  it.each([
    {
      key: "service",
      case: "two identical values",
      values: ["checkout", "checkout"],
      error: errors.serviceDuplicate,
    },
    {
      key: "service",
      case: "two different values",
      values: ["checkout", "auth"],
      error: errors.serviceDuplicate,
    },
    {
      key: "service",
      case: "a single-element string array",
      values: ["checkout"],
      error: errors.serviceDuplicate,
    },
    {
      key: "level",
      case: "two identical values",
      values: ["info", "info"],
      error: errors.levelDuplicate,
    },
    {
      key: "level",
      case: "two different values",
      values: ["info", "error"],
      error: errors.levelDuplicate,
    },
    {
      key: "level",
      case: "a single-element string array",
      values: ["info"],
      error: errors.levelDuplicate,
    },
    {
      key: "since",
      case: "two identical values",
      values: ["2026-01-15T12:00:00Z", "2026-01-15T12:00:00Z"],
      error: errors.sinceDuplicate,
    },
    {
      key: "since",
      case: "two different values",
      values: ["2026-01-15T12:00:00Z", "2026-01-15T13:00:00Z"],
      error: errors.sinceDuplicate,
    },
    {
      key: "since",
      case: "a single-element string array",
      values: ["2026-01-15T12:00:00Z"],
      error: errors.sinceDuplicate,
    },
    {
      key: "until",
      case: "two identical values",
      values: ["2026-01-15T13:00:00Z", "2026-01-15T13:00:00Z"],
      error: errors.untilDuplicate,
    },
    {
      key: "until",
      case: "two different values",
      values: ["2026-01-15T13:00:00Z", "2026-01-15T14:00:00Z"],
      error: errors.untilDuplicate,
    },
    {
      key: "until",
      case: "a single-element string array",
      values: ["2026-01-15T13:00:00Z"],
      error: errors.untilDuplicate,
    },
    { key: "q", case: "two identical values", values: ["same", "same"], error: errors.qDuplicate },
    {
      key: "q",
      case: "two different values",
      values: ["first", "second"],
      error: errors.qDuplicate,
    },
    {
      key: "q",
      case: "a single-element string array",
      values: ["single"],
      error: errors.qDuplicate,
    },
    {
      key: "limit",
      case: "two identical values",
      values: ["10", "10"],
      error: errors.limitDuplicate,
    },
    {
      key: "limit",
      case: "two different values",
      values: ["10", "20"],
      error: errors.limitDuplicate,
    },
    {
      key: "limit",
      case: "a single-element string array",
      values: ["10"],
      error: errors.limitDuplicate,
    },
    {
      key: "cursor",
      case: "two identical values",
      values: ["same", "same"],
      error: errors.cursorDuplicate,
    },
    {
      key: "cursor",
      case: "two different values",
      values: ["first", "second"],
      error: errors.cursorDuplicate,
    },
    {
      key: "cursor",
      case: "a single-element string array",
      values: ["single"],
      error: errors.cursorDuplicate,
    },
  ])("rejects $key with $case", ({ key, values, error }) => {
    expectListFailure({ [key]: values }, error);
  });
});

describe("unknown and hostile-looking input", () => {
  it("recognizes only the literal attr. prefix and ignores other unknown parameters", () => {
    const input = Object.create(null) as Record<string, unknown>;
    input["servce"] = "misspelled";
    input["attr"] = "missing dot";
    input["attribute"] = "different prefix";
    input["metadata"] = ["one", "two"];
    input["__proto__"] = "ignored";
    Reflect.set(input, "constructor", "ignored");
    input[`unknown${NUL}name`] = `ignored${NUL}value`;

    expect(expectListSuccess(input)).toEqual({ filters: { attributes: [] }, limit: 100 });
    expect(Object.getPrototypeOf(input)).toBeNull();
  });

  it("keeps list-only values outside the reusable shared-filter model", () => {
    expect(expectFilterSuccess({ limit: ["invalid", "duplicate"], cursor: "" })).toEqual({
      attributes: [],
    });
  });

  it("preserves SQL-looking recognized strings as data", () => {
    const value = expectFilterSuccess({
      service: "' OR TRUE --",
      'attr.key"} || dangerous': "value'); DROP TABLE logs; --",
      q: "%_\\' UNION SELECT",
    });

    expect(value).toEqual({
      attributes: [{ key: 'key"} || dangerous', value: "value'); DROP TABLE logs; --" }],
      service: "' OR TRUE --",
      q: "%_\\' UNION SELECT",
    });
  });

  it("never reflects a submitted value in an error envelope", () => {
    const hostileValue = `secret-database-url-${NUL}-DROP-TABLE`;
    const result = parseLogListQuery({ service: hostileValue });

    expect(result).toEqual({ ok: false, error: { error: errors.serviceNul } });
    expect(JSON.stringify(result)).not.toContain("secret-database-url");
    expect(JSON.stringify(result)).not.toContain("DROP-TABLE");
  });
});

describe("deterministic error precedence", () => {
  it.each([
    {
      name: "service before level",
      input: { service: 42, level: "critical" },
      error: errors.serviceString,
    },
    {
      name: "level before timestamps",
      input: { level: "critical", since: "invalid" },
      error: errors.levelValue,
    },
    {
      name: "since before until",
      input: { since: "invalid", until: "invalid" },
      error: errors.sinceTimestamp,
    },
    {
      name: "range before attributes",
      input: {
        since: "2026-01-15T13:00:00Z",
        until: "2026-01-15T12:00:00Z",
        "attr.": "invalid",
      },
      error: errors.range,
    },
    {
      name: "attributes before q",
      input: { "attr.": "invalid", q: 42 },
      error: errors.attributeKey,
    },
    {
      name: "q before limit",
      input: { q: 42, limit: "invalid" },
      error: errors.qString,
    },
    {
      name: "limit before cursor",
      input: { limit: "invalid", cursor: "" },
      error: errors.limitValue,
    },
  ])("checks $name", ({ input, error }) => {
    expectListFailure(input, error);
  });
});
