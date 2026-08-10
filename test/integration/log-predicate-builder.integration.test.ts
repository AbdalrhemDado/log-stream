import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseCanonicalTimestamp } from "../../src/domain/timestamp.js";
import { buildLogPredicate } from "../../src/modules/query/log-predicate-builder.js";
import type { LogFilters } from "../../src/modules/query/query-parameter-parser.js";

const runtimeDatabaseUrl = process.env["TEST_RUNTIME_DATABASE_URL"];

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

describe.skipIf(runtimeDatabaseUrl === undefined)("log predicate builder with PostgreSQL", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: runtimeDatabaseUrl });
    await client.connect();

    const role = await client.query<{ current_user: string }>("SELECT current_user");
    expect(role.rows).toEqual([{ current_user: "logstream_runtime" }]);
  });

  afterAll(async () => {
    await client.end();
  });

  async function matchingIds(input: LogFilters): Promise<readonly number[]> {
    const predicate = buildLogPredicate(input);
    const result = await client.query<{ id: number }>(
      `
WITH candidates (id, service, level, "timestamp", attributes_search, message) AS (
  VALUES
    (
      1,
      'checkout'::text,
      'error'::text,
      '2026-08-10T12:00:00.000Z'::timestamptz,
      '{"retries":"3","enabled":"true","negative_zero":"0","leading":"03","__proto__":"prototype value","constructor":"constructor value","quote\\"key":"value"}'::jsonb
        || jsonb_build_object(
          'unicode-שלום',
          'ערך-世界',
          E'backslash-\\\\key',
          E'value-\\\\path'
        ),
      E'Payment DECLINED; literal % and _ and \\\\ path'::text
    ),
    (
      2,
      'auth'::text,
      'info'::text,
      '2026-08-10T12:30:00.000Z'::timestamptz,
      '{"retries":"2","enabled":"false"}'::jsonb,
      'ordinary event'::text
    ),
    (
      3,
      'checkout'::text,
      'warn'::text,
      '2026-08-10T13:00:00.000Z'::timestamptz,
      '{"retries":"3","enabled":"false"}'::jsonb,
      'later checkout event'::text
    )
)
SELECT id
FROM candidates
WHERE ${predicate.text}
ORDER BY id
`,
      [...predicate.values],
    );

    return result.rows.map((row) => row.id);
  }

  it("executes exact service, level, and half-open timestamp predicates", async () => {
    await expect(matchingIds(filters({ service: "checkout" }))).resolves.toEqual([1, 3]);
    await expect(matchingIds(filters({ level: "info" }))).resolves.toEqual([2]);
    await expect(
      matchingIds(filters({ since: canonicalTimestamp("2026-08-10T12:30:00.000Z") })),
    ).resolves.toEqual([2, 3]);
    await expect(
      matchingIds(filters({ until: canonicalTimestamp("2026-08-10T13:00:00.000Z") })),
    ).resolves.toEqual([1, 2]);
    await expect(
      matchingIds(
        filters({
          since: canonicalTimestamp("2026-08-10T12:30:00.000Z"),
          until: canonicalTimestamp("2026-08-10T12:30:00.000Z"),
        }),
      ),
    ).resolves.toEqual([]);
  });

  it("executes one predicate containing every supported filter", async () => {
    await expect(
      matchingIds(
        filters({
          service: "checkout",
          level: "error",
          since: canonicalTimestamp("2026-08-10T12:00:00.000Z"),
          until: canonicalTimestamp("2026-08-10T12:30:00.000Z"),
          attributes: [
            { key: "retries", value: "3" },
            { key: "enabled", value: "true" },
          ],
          q: "payment declined",
        }),
      ),
    ).resolves.toEqual([1]);
  });

  it("returns no rows for ordinary service and level mismatches", async () => {
    await expect(matchingIds(filters({ service: "billing" }))).resolves.toEqual([]);
    await expect(matchingIds(filters({ level: "debug" }))).resolves.toEqual([]);
  });

  it("executes multiple JSONB attribute predicates with string-normalized equality", async () => {
    await expect(
      matchingIds(
        filters({
          attributes: [
            { key: "retries", value: "3" },
            { key: "enabled", value: "true" },
          ],
        }),
      ),
    ).resolves.toEqual([1]);
    await expect(
      matchingIds(filters({ attributes: [{ key: "retries", value: "3" }] })),
    ).resolves.toEqual([1, 3]);
    await expect(
      matchingIds(filters({ attributes: [{ key: "negative_zero", value: "0" }] })),
    ).resolves.toEqual([1]);
    await expect(
      matchingIds(filters({ attributes: [{ key: "retries", value: "03" }] })),
    ).resolves.toEqual([]);
    await expect(
      matchingIds(filters({ attributes: [{ key: "leading", value: "03" }] })),
    ).resolves.toEqual([1]);
  });

  it("executes prototype-sensitive and JSON-sensitive attribute keys safely", async () => {
    await expect(
      matchingIds(
        filters({
          attributes: [
            { key: "__proto__", value: "prototype value" },
            { key: "constructor", value: "constructor value" },
            { key: 'quote"key', value: "value" },
          ],
        }),
      ),
    ).resolves.toEqual([1]);
    expect(Object.hasOwn(Object.prototype, "prototype value")).toBe(false);
  });

  it("keeps Unicode and backslash attribute keys and values as matching data", async () => {
    await expect(
      matchingIds(
        filters({
          attributes: [
            { key: "unicode-שלום", value: "ערך-世界" },
            { key: "backslash-\\key", value: "value-\\path" },
          ],
        }),
      ),
    ).resolves.toEqual([1]);
  });

  it("uses one PostgreSQL backslash escape character for literal ILIKE substrings", async () => {
    await expect(matchingIds(filters({ q: "payment declined" }))).resolves.toEqual([1]);
    await expect(matchingIds(filters({ q: "%" }))).resolves.toEqual([1]);
    await expect(matchingIds(filters({ q: "_" }))).resolves.toEqual([1]);
    await expect(matchingIds(filters({ q: "\\" }))).resolves.toEqual([1]);
    await expect(matchingIds(filters({ q: "% and _ and \\" }))).resolves.toEqual([1]);
  });

  it("keeps injection payloads isolated as data during real SQL execution", async () => {
    await expect(matchingIds(filters({ service: "' OR TRUE --" }))).resolves.toEqual([]);
    await expect(
      matchingIds(filters({ attributes: [{ key: 'key"} OR TRUE --', value: "anything" }] })),
    ).resolves.toEqual([]);
    await expect(matchingIds(filters({ q: "%' OR TRUE --" }))).resolves.toEqual([]);
  });
});
