import { describe, expect, it, vi } from "vitest";

import {
  compareParsedTimestamps,
  isParsedTimestampAfterEpochMilliseconds,
  parseCanonicalTimestamp,
  type ParsedTimestamp,
} from "../../src/domain/timestamp.js";

function parseSuccess(value: string): ParsedTimestamp {
  const result = parseCanonicalTimestamp(value);

  expect(result.ok).toBe(true);

  if (!result.ok) {
    throw new Error(`Expected timestamp success but received ${result.kind}`);
  }

  return result.value;
}

describe("parseCanonicalTimestamp", () => {
  it.each([
    {
      name: "Z without a fraction",
      input: "2026-01-15T12:00:00Z",
      expected: "2026-01-15T12:00:00.000Z",
    },
    {
      name: "a positive offset",
      input: "2026-01-15T14:00:00+02:00",
      expected: "2026-01-15T12:00:00.000Z",
    },
    {
      name: "a negative offset",
      input: "2026-01-15T07:00:00-05:00",
      expected: "2026-01-15T12:00:00.000Z",
    },
    {
      name: "millisecond precision",
      input: "2026-01-15T12:00:00.123Z",
      expected: "2026-01-15T12:00:00.123Z",
    },
    {
      name: "significant sub-millisecond precision",
      input: "2026-01-15T12:00:00.123400Z",
      expected: "2026-01-15T12:00:00.1234Z",
    },
    {
      name: "a real leap day",
      input: "2024-02-29T23:59:59.1Z",
      expected: "2024-02-29T23:59:59.100Z",
    },
  ])("normalizes $name to canonical UTC", ({ input, expected }) => {
    expect(parseSuccess(input).canonical).toBe(expected);
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
  ])("rejects a value outside the approved grammar: %s", (input) => {
    expect(parseCanonicalTimestamp(input)).toEqual({ ok: false, kind: "grammar" });
  });

  it.each([
    "2026-02-29T12:00:00Z",
    "2026-02-30T12:00:00Z",
    "2026-04-31T12:00:00Z",
    "2026-00-15T12:00:00Z",
    "2026-13-15T12:00:00Z",
    "2026-01-15T24:00:00Z",
    "2026-01-15T12:60:00Z",
    "2026-01-15T12:00:60Z",
    "2026-01-15T12:00:00+15:00",
    "2026-01-15T12:00:00+14:01",
    "2026-01-15T12:00:00-02:60",
  ])("rejects invalid calendar, clock, or offset components: %s", (input) => {
    expect(parseCanonicalTimestamp(input)).toEqual({ ok: false, kind: "components" });
  });

  it("does not read the current time", () => {
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now must not be called");
    });

    expect(parseSuccess("2099-01-15T12:00:00Z").canonical).toBe("2099-01-15T12:00:00.000Z");
    expect(nowSpy).not.toHaveBeenCalled();
  });

  it("preserves canonical millisecond input and its comparison components", () => {
    const parsed = parseSuccess("2026-01-15T12:00:00.123Z");

    expect(parsed).toEqual({
      canonical: "2026-01-15T12:00:00.123Z",
      wholeSecondMs: Date.UTC(2026, 0, 15, 12, 0, 0),
      fraction: "123",
    });
  });

  it("rejects invalid canonical-shaped millisecond input as invalid components", () => {
    expect(parseCanonicalTimestamp("2026-02-29T12:00:00.123Z")).toEqual({
      ok: false,
      kind: "components",
    });
  });

  it("keeps the whole-second boundary correct before the Unix epoch", () => {
    const parsed = parseSuccess("1969-12-31T23:59:59.123Z");

    expect(parsed.wholeSecondMs).toBe(-1_000);
    expect(parsed.fraction).toBe("123");
  });
});

describe("timestamp comparison", () => {
  it.each([
    {
      name: "an earlier whole second",
      left: "2026-01-15T11:59:59.999Z",
      right: "2026-01-15T12:00:00.000Z",
      expected: -1,
    },
    {
      name: "the same instant through different offsets",
      left: "2026-01-15T14:00:00+02:00",
      right: "2026-01-15T07:00:00-05:00",
      expected: 0,
    },
    {
      name: "equivalent fractional spellings",
      left: "2026-01-15T12:00:00.1000Z",
      right: "2026-01-15T12:00:00.1Z",
      expected: 0,
    },
    {
      name: "an earlier sub-millisecond instant",
      left: "2026-01-15T12:00:00.00009Z",
      right: "2026-01-15T12:00:00.0001Z",
      expected: -1,
    },
    {
      name: "a later sub-millisecond instant",
      left: "2026-01-15T12:00:00.0001001Z",
      right: "2026-01-15T12:00:00.0001Z",
      expected: 1,
    },
  ])("compares $name", ({ left, right, expected }) => {
    expect(compareParsedTimestamps(parseSuccess(left), parseSuccess(right))).toBe(expected);
  });

  it("compares a parsed timestamp with an epoch-millisecond boundary", () => {
    const boundaryMs = Date.UTC(2026, 0, 15, 12, 0, 0, 123);

    expect(
      isParsedTimestampAfterEpochMilliseconds(parseSuccess("2026-01-15T12:00:00.123Z"), boundaryMs),
    ).toBe(false);
    expect(
      isParsedTimestampAfterEpochMilliseconds(
        parseSuccess("2026-01-15T12:00:00.1230001Z"),
        boundaryMs,
      ),
    ).toBe(true);
  });
});
