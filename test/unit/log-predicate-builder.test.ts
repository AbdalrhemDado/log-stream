import { describe, expect, it } from "vitest";

import { parseCanonicalTimestamp } from "../../src/domain/timestamp.js";
import { buildLogPredicate } from "../../src/modules/query/log-predicate-builder.js";
import type { LogFilters } from "../../src/modules/query/query-parameter-parser.js";

function filters(overrides: Partial<LogFilters> = {}): LogFilters {
  return { attributes: [], ...overrides };
}

function canonicalTimestamp(value: string) {
  const result = parseCanonicalTimestamp(value);
  if (!result.ok) {
    throw new Error("The test fixture timestamp must be canonicalizable.");
  }

  return result.value.canonical;
}

describe("buildLogPredicate", () => {
  it("returns a reusable always-true predicate when no filters are present", () => {
    expect(buildLogPredicate(filters())).toEqual({ text: "TRUE", values: [] });
  });

  it.each([
    {
      name: "service",
      input: filters({ service: "checkout" }),
      text: "service = $1::text",
      value: "checkout",
    },
    {
      name: "level",
      input: filters({ level: "error" }),
      text: "level = $1::text",
      value: "error",
    },
    {
      name: "inclusive since",
      input: filters({ since: canonicalTimestamp("2026-08-10T12:00:00.000Z") }),
      text: '"timestamp" >= $1::timestamptz',
      value: "2026-08-10T12:00:00.000Z",
    },
    {
      name: "exclusive until",
      input: filters({ until: canonicalTimestamp("2026-08-10T13:00:00.000Z") }),
      text: '"timestamp" < $1::timestamptz',
      value: "2026-08-10T13:00:00.000Z",
    },
  ])("builds the exact $name clause", ({ input, text, value }) => {
    expect(buildLogPredicate(input)).toEqual({ text, values: [value] });
  });

  it("binds equal canonical bounds separately for an empty half-open range", () => {
    const bound = canonicalTimestamp("2026-08-10T12:30:00.000Z");

    expect(buildLogPredicate(filters({ since: bound, until: bound }))).toEqual({
      text: '"timestamp" >= $1::timestamptz AND "timestamp" < $2::timestamptz',
      values: [bound, bound],
    });
  });

  it("uses the fixed clause and parameter order for every combinable filter", () => {
    const predicate = buildLogPredicate(
      filters({
        service: "checkout",
        level: "error",
        since: canonicalTimestamp("2026-08-10T12:00:00.000Z"),
        until: canonicalTimestamp("2026-08-10T13:00:00.000Z"),
        attributes: [
          { key: "enabled", value: "true" },
          { key: "retries", value: "3" },
        ],
        q: "declined",
      }),
    );

    expect(predicate).toEqual({
      text: 'service = $1::text AND level = $2::text AND "timestamp" >= $3::timestamptz AND "timestamp" < $4::timestamptz AND attributes_search @> $5::jsonb AND attributes_search @> $6::jsonb AND message ILIKE $7::text ESCAPE E\'\\\\\'',
      values: [
        "checkout",
        "error",
        "2026-08-10T12:00:00.000Z",
        "2026-08-10T13:00:00.000Z",
        '{"enabled":"true"}',
        '{"retries":"3"}',
        "%declined%",
      ],
    });
  });

  it("numbers partial combinations without gaps", () => {
    expect(
      buildLogPredicate(
        filters({
          level: "warn",
          until: canonicalTimestamp("2026-08-10T13:00:00.000Z"),
          q: "partial",
        }),
      ),
    ).toEqual({
      text: "level = $1::text AND \"timestamp\" < $2::timestamptz AND message ILIKE $3::text ESCAPE E'\\\\'",
      values: ["warn", "2026-08-10T13:00:00.000Z", "%partial%"],
    });
  });

  it("uses one parameterized JSONB containment object per attribute in existing order", () => {
    const predicate = buildLogPredicate(
      filters({
        attributes: [
          { key: "retries", value: "3" },
          { key: "enabled", value: "true" },
          { key: "leading", value: "03" },
        ],
      }),
    );

    expect(predicate).toEqual({
      text: "attributes_search @> $1::jsonb AND attributes_search @> $2::jsonb AND attributes_search @> $3::jsonb",
      values: ['{"retries":"3"}', '{"enabled":"true"}', '{"leading":"03"}'],
    });
  });

  it("serializes prototype-sensitive, Unicode, and JSON-sensitive attribute keys safely", () => {
    const before = Object.getOwnPropertyDescriptor(Object.prototype, "polluted");
    const predicate = buildLogPredicate(
      filters({
        attributes: [
          { key: "__proto__", value: "prototype value" },
          { key: "constructor", value: "constructor value" },
          { key: "prototype", value: "prototype key" },
          { key: "toString", value: "string key" },
          { key: "empty", value: "" },
          { key: "zero", value: "0" },
          { key: "negative_zero", value: "-0" },
          { key: 'quote"\\שלום', value: 'value"\\世界' },
        ],
      }),
    );

    expect(predicate.values).toEqual([
      '{"__proto__":"prototype value"}',
      '{"constructor":"constructor value"}',
      '{"prototype":"prototype key"}',
      '{"toString":"string key"}',
      '{"empty":""}',
      '{"zero":"0"}',
      '{"negative_zero":"-0"}',
      '{"quote\\"\\\\שלום":"value\\"\\\\世界"}',
    ]);
    expect(Object.getOwnPropertyDescriptor(Object.prototype, "polluted")).toEqual(before);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it.each([
    { q: "%", expected: "%\\%%" },
    { q: "_", expected: "%\\_%" },
    { q: "\\", expected: "%\\\\%" },
    { q: "50%_\\done", expected: "%50\\%\\_\\\\done%" },
    { q: "DeClInEd", expected: "%DeClInEd%" },
    { q: "%%", expected: "%\\%\\%%" },
    { q: "__", expected: "%\\_\\_%" },
    { q: "\\\\", expected: "%\\\\\\\\%" },
  ])("escapes q=$q as a literal substring pattern", ({ q, expected }) => {
    expect(buildLogPredicate(filters({ q }))).toEqual({
      text: "message ILIKE $1::text ESCAPE E'\\\\'",
      values: [expected],
    });
  });

  it("keeps SQL-injection payloads entirely out of SQL text", () => {
    const service = "' OR TRUE --";
    const attributeKey = 'key"} OR TRUE --';
    const attributeValue = "value'); DROP TABLE logstream.logs; --";
    const q = "%_' UNION SELECT current_user --\\";
    const predicate = buildLogPredicate(
      filters({
        service,
        attributes: [{ key: attributeKey, value: attributeValue }],
        q,
      }),
    );

    expect(predicate.text).toBe(
      "service = $1::text AND attributes_search @> $2::jsonb AND message ILIKE $3::text ESCAPE E'\\\\'",
    );
    expect(predicate.text).not.toContain(service);
    expect(predicate.text).not.toContain(attributeKey);
    expect(predicate.text).not.toContain(attributeValue);
    expect(predicate.text).not.toContain(q);
    expect(predicate.values).toEqual([
      service,
      JSON.stringify({ [attributeKey]: attributeValue }),
      "%\\%\\_' UNION SELECT current\\_user --\\\\%",
    ]);
  });

  it("does not mutate inputs and returns fresh result objects and arrays", () => {
    const attributes = Object.freeze([{ key: "enabled", value: "true" }] as const);
    const input = Object.freeze(filters({ service: "checkout", attributes }));
    const first = buildLogPredicate(input);
    const second = buildLogPredicate(input);

    expect(input).toEqual({ service: "checkout", attributes });
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.values).not.toBe(second.values);
  });
});
