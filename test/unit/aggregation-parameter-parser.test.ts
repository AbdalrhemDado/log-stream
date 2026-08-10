import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AGGREGATION_BUCKETS,
  AGGREGATION_GROUPS,
  parseLogAggregationQuery,
  type AggregationBucket,
  type AggregationGroupBy,
  type ParsedLogAggregationQuery,
} from "../../src/modules/aggregation/aggregation-parameter-parser.js";

const SINCE = "2026-01-15T12:00:00Z";
const UNTIL = "2026-01-15T13:00:00Z";
const NUL = "\u0000";

const errors = {
  queryObject: "Query parameters must be a non-null object.",
  serviceDuplicate: "Query parameter 'service' must appear at most once.",
  serviceString: "Query parameter 'service' must be a string.",
  serviceNul: "Query parameter 'service' must not contain U+0000.",
  levelValue: "Query parameter 'level' must be one of debug, info, warn, or error.",
  sinceDuplicate: "Query parameter 'since' must appear at most once.",
  sinceTimestamp: "Query parameter 'since' must be a valid timezone-bearing ISO 8601 date-time.",
  untilDuplicate: "Query parameter 'until' must appear at most once.",
  untilTimestamp: "Query parameter 'until' must be a valid timezone-bearing ISO 8601 date-time.",
  range: "Query parameter 'until' must not be earlier than 'since'.",
  attributeKey: "Attribute query parameters must include a non-empty key after 'attr.'.",
  attributeDuplicate: "Each attribute query key must appear at most once.",
  attributeKeyNul: "Attribute query keys must not contain U+0000.",
  attributeValueNul: "Attribute query values must not contain U+0000.",
  qString: "Query parameter 'q' must be a string.",
  qNul: "Query parameter 'q' must not contain U+0000.",
  sinceRequired: "Query parameter 'since' is required.",
  untilRequired: "Query parameter 'until' is required.",
  bucketRequired: "Query parameter 'bucket' is required.",
  bucketDuplicate: "Query parameter 'bucket' must appear at most once.",
  bucketValue: "Query parameter 'bucket' must be one of 1m, 5m, 1h, or 1d.",
  groupByDuplicate: "Query parameter 'group_by' must appear at most once.",
  groupByValue: "Query parameter 'group_by' must be one of service or level.",
} as const;

function validQuery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { since: SINCE, until: UNTIL, bucket: "1m", ...overrides };
}

function expectSuccess(input: unknown): ParsedLogAggregationQuery {
  const result = parseLogAggregationQuery(input);

  expect(result.ok).toBe(true);

  if (!result.ok) {
    throw new Error(`Expected aggregation-query success but received: ${result.error.error}`);
  }

  return result.value;
}

function expectFailure(input: unknown, error: string): void {
  expect(parseLogAggregationQuery(input)).toEqual({ ok: false, error: { error } });
}

describe("aggregation literal contracts", () => {
  it("exports the four buckets and two groups in their approved order", () => {
    expect(AGGREGATION_BUCKETS).toEqual(["1m", "5m", "1h", "1d"]);
    expect(AGGREGATION_GROUPS).toEqual(["service", "level"]);
    expectTypeOf<AggregationBucket>().toEqualTypeOf<"1m" | "5m" | "1h" | "1d">();
    expectTypeOf<AggregationGroupBy>().toEqualTypeOf<"service" | "level">();
  });

  it.each(AGGREGATION_BUCKETS)("accepts the exact %s bucket", (bucket) => {
    const value = expectSuccess(validQuery({ bucket }));

    expect(value.bucket).toBe(bucket);
    expectTypeOf(value.bucket).toEqualTypeOf<AggregationBucket>();
  });

  it.each(AGGREGATION_GROUPS)("accepts the exact %s grouping", (groupBy) => {
    const value = expectSuccess(validQuery({ group_by: groupBy }));

    expect(value.groupBy).toBe(groupBy);
    expectTypeOf(value.groupBy).toEqualTypeOf<AggregationGroupBy | undefined>();
  });

  it("omits groupBy when group_by is absent", () => {
    const value = expectSuccess(validQuery());

    expect(Object.hasOwn(value, "groupBy")).toBe(false);
  });
});

describe("required timestamps and range behavior", () => {
  it.each([
    { input: { until: UNTIL, bucket: "1m" }, error: errors.sinceRequired },
    { input: { since: SINCE, bucket: "1m" }, error: errors.untilRequired },
    { input: { since: SINCE, until: UNTIL }, error: errors.bucketRequired },
  ])("rejects a missing required parameter with $error", ({ input, error }) => {
    expectFailure(input, error);
  });

  it("canonicalizes offset timestamps and preserves significant microseconds", () => {
    const value = expectSuccess({
      since: "2026-01-15T14:00:00.123400+02:00",
      until: "2026-01-15T08:00:00.654321-05:00",
      bucket: "5m",
    });

    expect(value.filters.since).toBe("2026-01-15T12:00:00.1234Z");
    expect(value.filters.until).toBe("2026-01-15T13:00:00.654321Z");
  });

  it("accepts equal offset-equivalent bounds", () => {
    const value = expectSuccess({
      since: "2026-01-15T14:00:00+02:00",
      until: "2026-01-15T07:00:00-05:00",
      bucket: "1h",
    });

    expect(value.filters.since).toBe("2026-01-15T12:00:00.000Z");
    expect(value.filters.until).toBe("2026-01-15T12:00:00.000Z");
  });

  it("permits future query ranges", () => {
    const value = expectSuccess({
      since: "2099-01-15T12:00:00Z",
      until: "2099-01-15T13:00:00Z",
      bucket: "1d",
    });

    expect(value.filters.since).toBe("2099-01-15T12:00:00.000Z");
  });

  it.each([
    { input: validQuery({ since: "invalid" }), error: errors.sinceTimestamp },
    { input: validQuery({ since: "2026-01-15T12:00:00" }), error: errors.sinceTimestamp },
    { input: validQuery({ until: "2026-02-30T12:00:00Z" }), error: errors.untilTimestamp },
    { input: validQuery({ until: "2026-01-15T12:00:00+14:01" }), error: errors.untilTimestamp },
    {
      input: validQuery({
        since: "2026-01-15T12:00:00.0001001Z",
        until: "2026-01-15T12:00:00.0001Z",
      }),
      error: errors.range,
    },
  ])("preserves shared timestamp failure: $error", ({ input, error }) => {
    expectFailure(input, error);
  });
});

describe("shared filter reuse", () => {
  it("parses every shared filter and sorts attributes by code unit", () => {
    const input = Object.create(null) as Record<string, unknown>;
    input["attr.地域"] = "中東\\value";
    input["attr.empty"] = "";
    input["attr.toString"] = "to-string value";
    input["attr.constructor"] = "constructor value";
    input["attr.__proto__"] = "prototype value";
    input["service"] = " checkout ";
    input["level"] = "error";
    input["since"] = SINCE;
    input["until"] = UNTIL;
    input["q"] = "Payment_%\\Declined";
    input["bucket"] = "5m";
    input["group_by"] = "service";

    expect(expectSuccess(input)).toEqual({
      filters: {
        attributes: [
          { key: "__proto__", value: "prototype value" },
          { key: "constructor", value: "constructor value" },
          { key: "empty", value: "" },
          { key: "toString", value: "to-string value" },
          { key: "地域", value: "中東\\value" },
        ],
        service: " checkout ",
        level: "error",
        since: "2026-01-15T12:00:00.000Z",
        until: "2026-01-15T13:00:00.000Z",
        q: "Payment_%\\Declined",
      },
      bucket: "5m",
      groupBy: "service",
    });
    expect(Object.getPrototypeOf(input)).toBeNull();
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it("normalizes empty q away", () => {
    const value = expectSuccess(validQuery({ q: "" }));

    expect(Object.hasOwn(value.filters, "q")).toBe(false);
  });

  it("ignores unrelated, list-only, and prototype-sensitive unknown parameters", () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, validQuery(), {
      metadata: ["ignored", "twice"],
      limit: ["invalid", "duplicate"],
      cursor: "",
      constructor: "ignored",
    });
    input["__proto__"] = "ignored";

    const value = expectSuccess(input);

    expect(value).toEqual({
      filters: {
        attributes: [],
        since: "2026-01-15T12:00:00.000Z",
        until: "2026-01-15T13:00:00.000Z",
      },
      bucket: "1m",
    });
    expect(Object.getPrototypeOf(input)).toBeNull();
  });

  it("does not mutate or reuse the caller's object", () => {
    const input = Object.freeze({
      since: SINCE,
      until: UNTIL,
      bucket: "1m",
      service: "checkout",
      "attr.request_id": "abc",
    });

    const value = expectSuccess(input);

    expect(input).toEqual({
      since: SINCE,
      until: UNTIL,
      bucket: "1m",
      service: "checkout",
      "attr.request_id": "abc",
    });
    expect(value).not.toBe(input);
    expect(value.filters).not.toBe(input);
    expect(value.filters.attributes).not.toBe(input);
  });

  it("preserves the existing unpaired-surrogate behavior", () => {
    expect(expectSuccess(validQuery({ service: "service\ud800name" })).filters.service).toBe(
      "service\ud800name",
    );
  });

  it.each([
    { input: validQuery({ service: 42 }), error: errors.serviceString },
    { input: validQuery({ level: "critical" }), error: errors.levelValue },
    { input: validQuery({ "attr.": "value" }), error: errors.attributeKey },
    { input: validQuery({ "attr.key": ["same", "same"] }), error: errors.attributeDuplicate },
    {
      input: validQuery({ [`attr.unsafe${NUL}key`]: "value" }),
      error: errors.attributeKeyNul,
    },
    {
      input: validQuery({ "attr.key": `unsafe${NUL}value` }),
      error: errors.attributeValueNul,
    },
    { input: validQuery({ q: 42 }), error: errors.qString },
    { input: validQuery({ q: `unsafe${NUL}value` }), error: errors.qNul },
    { input: validQuery({ service: `unsafe${NUL}value` }), error: errors.serviceNul },
  ])("returns a shared filter error unchanged: $error", ({ input, error }) => {
    expectFailure(input, error);
  });
});

describe("aggregation-specific scalar validation", () => {
  it.each([
    "",
    "1M",
    " 1m",
    "1m ",
    "15m",
    "0",
    "+1m",
    "1 minute",
    "1m'; DROP TABLE logs; --",
    "1m OR TRUE",
    "1m/*comment*/",
  ])("rejects unsupported bucket data: %j", (bucket) => {
    expectFailure(validQuery({ bucket }), errors.bucketValue);
  });

  it.each([42, true, null, {}, Symbol("1m")])("rejects a non-string bucket: %j", (bucket) => {
    expectFailure(validQuery({ bucket }), errors.bucketValue);
  });

  it.each([
    "",
    "Service",
    "LEVEL",
    " service",
    "level ",
    "message",
    "service,level",
    "service; DROP TABLE logs; --",
    '"service"',
  ])("rejects unsupported group_by data: %j", (groupBy) => {
    expectFailure(validQuery({ group_by: groupBy }), errors.groupByValue);
  });

  it.each([42, true, null, {}, Symbol("service")])(
    "rejects a non-string group_by: %j",
    (groupBy) => {
      expectFailure(validQuery({ group_by: groupBy }), errors.groupByValue);
    },
  );

  it.each([
    { key: "bucket", values: ["1m"], error: errors.bucketDuplicate },
    { key: "bucket", values: ["1m", "1m"], error: errors.bucketDuplicate },
    { key: "bucket", values: ["1m", "5m"], error: errors.bucketDuplicate },
    { key: "group_by", values: ["service"], error: errors.groupByDuplicate },
    { key: "group_by", values: ["service", "service"], error: errors.groupByDuplicate },
    { key: "group_by", values: ["service", "level"], error: errors.groupByDuplicate },
  ])("rejects duplicate $key values represented as $values", ({ key, values, error }) => {
    expectFailure(validQuery({ [key]: values }), error);
  });

  it.each([
    { key: "bucket", error: errors.bucketValue },
    { key: "group_by", error: errors.groupByValue },
  ])("rejects an enumerable $key accessor without invoking it", ({ key, error }) => {
    const input = validQuery();
    let calls = 0;
    Object.defineProperty(input, key, {
      enumerable: true,
      get: () => {
        calls += 1;
        return key === "bucket" ? "1m" : "service";
      },
    });

    expectFailure(input, error);
    expect(calls).toBe(0);
  });
});

describe("own enumerable property boundary", () => {
  it("does not evaluate unknown accessors", () => {
    const input = validQuery();
    let calls = 0;
    Object.defineProperty(input, "metadata", {
      enumerable: true,
      get: () => {
        calls += 1;
        return "ignored";
      },
    });

    expectSuccess(input);
    expect(calls).toBe(0);
  });

  it.each([
    { key: "since", expectedError: errors.sinceRequired },
    { key: "until", expectedError: errors.untilRequired },
    { key: "bucket", expectedError: errors.bucketRequired },
  ])("does not accept an inherited required $key", ({ key, expectedError }) => {
    const own = validQuery();
    const inheritedValue = own[key];
    Reflect.deleteProperty(own, key);
    const input = Object.assign(Object.create({ [key]: inheritedValue }) as object, own);

    expectFailure(input, expectedError);
  });

  it.each([
    { key: "since", expectedError: errors.sinceRequired },
    { key: "until", expectedError: errors.untilRequired },
    { key: "bucket", expectedError: errors.bucketRequired },
  ])("does not accept a non-enumerable required $key", ({ key, expectedError }) => {
    const input = validQuery();
    const value = input[key];
    Object.defineProperty(input, key, { enumerable: false, value });

    expectFailure(input, expectedError);
  });

  it("ignores inherited and non-enumerable group_by", () => {
    const input = Object.assign(Object.create({ group_by: "service" }) as object, validQuery());
    Object.defineProperty(input, "group_by", { enumerable: false, value: "level" });

    const value = expectSuccess(input);

    expect(Object.hasOwn(value, "groupBy")).toBe(false);
  });
});

describe("deterministic error precedence and redaction", () => {
  it.each([
    {
      name: "shared service before all aggregation checks",
      input: { service: 42, bucket: "invalid", group_by: "invalid" },
      error: errors.serviceString,
    },
    {
      name: "shared since syntax before missing until and invalid bucket",
      input: { since: "invalid", bucket: "invalid" },
      error: errors.sinceTimestamp,
    },
    {
      name: "shared range before invalid bucket",
      input: {
        since: UNTIL,
        until: SINCE,
        bucket: "invalid",
      },
      error: errors.range,
    },
    {
      name: "missing since before missing until and bucket",
      input: {},
      error: errors.sinceRequired,
    },
    {
      name: "missing until before invalid bucket",
      input: { since: SINCE, bucket: "invalid" },
      error: errors.untilRequired,
    },
    {
      name: "invalid bucket before invalid group_by",
      input: validQuery({ bucket: "invalid-secret", group_by: "invalid-group-secret" }),
      error: errors.bucketValue,
    },
  ])("checks $name", ({ input, error }) => {
    expectFailure(input, error);
  });

  it.each([null, undefined, [], "since=2026-01-15T12:00:00Z", 42, true])(
    "preserves the shared query-container error for %j",
    (input) => {
      expectFailure(input, errors.queryObject);
    },
  );

  it("does not expose rejected input or internal SQL details", () => {
    const submitted = "secret-database-url'); DROP TABLE logs; --";
    const result = parseLogAggregationQuery(validQuery({ bucket: submitted }));
    const serialized = JSON.stringify(result);

    expect(result).toEqual({ ok: false, error: { error: errors.bucketValue } });
    expect(serialized).not.toContain("secret-database-url");
    expect(serialized).not.toContain("DROP TABLE");
    expect(serialized).not.toContain("SELECT");
    expect(serialized).not.toContain("PostgreSQL");
  });

  it("preserves shared duplicate errors before aggregation validation", () => {
    expectFailure(validQuery({ since: [SINCE] }), errors.sinceDuplicate);
    expectFailure(validQuery({ until: [UNTIL, UNTIL] }), errors.untilDuplicate);
    expectFailure(validQuery({ service: ["checkout", "checkout"] }), errors.serviceDuplicate);
  });
});
