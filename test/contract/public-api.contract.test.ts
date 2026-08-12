import { describe, expect, it } from "vitest";

const EXPECTED_BASE_URL = "http://127.0.0.1:8080";
const RUN_ID_PATTERN = /^contract-[0-9]+-[a-z0-9]+$/u;
const REQUEST_TIMEOUT_MS = 15_000;
const BEARER_SENTINEL = "contract-unknown-bearer-sentinel";
const FORBIDDEN_ERROR_FRAGMENTS = [
  "select ",
  "insert ",
  "postgres",
  "database_url",
  "password",
  "stack",
  "fingerprint",
  BEARER_SENTINEL,
] as const;

interface ContractConfiguration {
  readonly baseUrl: typeof EXPECTED_BASE_URL;
  readonly runId: string;
}

interface HttpResult {
  readonly response: Response;
  readonly body: unknown;
  readonly text: string;
}

function readConfiguration(): ContractConfiguration | undefined {
  const baseUrl = process.env["CONTRACT_BASE_URL"];
  const runId = process.env["CONTRACT_RUN_ID"];
  if (baseUrl === undefined && runId === undefined) {
    return undefined;
  }
  if (baseUrl !== EXPECTED_BASE_URL || runId === undefined || !RUN_ID_PATTERN.test(runId)) {
    throw new Error("Contract test environment is invalid.");
  }
  return { baseUrl, runId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  expect(isRecord(value)).toBe(true);
  return value as Record<string, unknown>;
}

function expectExactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = requireRecord(value);
  expect(Object.keys(record).sort()).toEqual([...keys].sort());
  return record;
}

function expectSafeError(result: HttpResult, expectedStatus = 400): Record<string, unknown> {
  expect(result.response.status).toBe(expectedStatus);
  const body = expectExactKeys(result.body, ["error"]);
  expect(typeof body["error"]).toBe("string");
  expect((body["error"] as string).length).toBeGreaterThan(0);
  const normalized = result.text.toLowerCase();
  for (const fragment of FORBIDDEN_ERROR_FRAGMENTS) {
    expect(normalized).not.toContain(fragment.toLowerCase());
  }
  return body;
}

const configuration = readConfiguration();
const contractEnabled = configuration !== undefined;
const baseUrl = configuration?.baseUrl ?? EXPECTED_BASE_URL;
const runId = configuration?.runId ?? "contract-0-disabled";

async function request(path: string, init: RequestInit = {}): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  expect(contentType).toMatch(/^application\/json(?:;|$)/u);
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Public endpoint returned invalid JSON.");
  }
  return { response, body, text };
}

function ingestionEntry(
  timestamp: string,
  service: string,
  message: string,
  attributes?: Record<string, string | number | boolean>,
  level: "debug" | "info" | "warn" | "error" = "info",
): Record<string, unknown> {
  return {
    timestamp,
    level,
    service,
    message,
    ...(attributes === undefined ? {} : { attributes }),
  };
}

function expectIngestionSuccess(result: HttpResult, accepted: number): void {
  expect(result.response.status).toBe(200);
  expect(result.body).toEqual({ accepted, rejected: [] });
}

function expectLogShape(value: unknown): Record<string, unknown> {
  const log = expectExactKeys(value, [
    "id",
    "timestamp",
    "level",
    "service",
    "message",
    "attributes",
  ]);
  expect(typeof log["id"]).toBe("string");
  expect(typeof log["timestamp"]).toBe("string");
  expect(["debug", "info", "warn", "error"]).toContain(log["level"]);
  expect(typeof log["service"]).toBe("string");
  expect(typeof log["message"]).toBe("string");
  expect(isRecord(log["attributes"])).toBe(true);
  return log;
}

function encodeQuery(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

describe.skipIf(!contractEnabled)("public Docker Compose contract", () => {
  it("keeps health public and leaves all data endpoints usable with disabled authentication", async () => {
    const health = await request("/health");
    expect(health.response.status).toBe(200);
    const authorizedHealth = await request("/health", {
      headers: { authorization: `Bearer ${BEARER_SENTINEL}` },
    });
    expect(authorizedHealth.response.status).toBe(200);

    const timestamp = new Date(Date.now() - 60_000).toISOString();
    const service = `${runId}-auth`;
    const headers = {
      authorization: `Bearer ${BEARER_SENTINEL}`,
      "content-type": "application/json",
    };
    const post = await request("/logs", {
      method: "POST",
      headers,
      body: JSON.stringify({
        logs: [ingestionEntry(timestamp, service, `${runId}-auth-message`)],
      }),
    });
    expectIngestionSuccess(post, 1);

    const list = await request(`/logs?${encodeQuery({ service })}`, {
      headers: { authorization: `Bearer ${BEARER_SENTINEL}` },
    });
    expect(list.response.status).toBe(200);
    expect((requireRecord(list.body)["logs"] as unknown[]).length).toBe(1);

    const since = new Date(new Date(timestamp).getTime() - 60_000).toISOString();
    const until = new Date(new Date(timestamp).getTime() + 60_000).toISOString();
    const aggregate = await request(
      `/logs/aggregate?${encodeQuery({ since, until, bucket: "1m", service })}`,
      { headers: { authorization: `Bearer ${BEARER_SENTINEL}` } },
    );
    expect(aggregate.response.status).toBe(200);
    expect(requireRecord(aggregate.body)["buckets"]).toEqual([
      expect.objectContaining({ group: null, count: 1 }),
    ]);
  });

  it("preserves valid ingestion data, ignores unknown fields, and enforces prototype and NUL boundaries", async () => {
    const timestamp = new Date(Date.now() - 90_000).toISOString();
    const service = ` ${runId}-preserved `;
    const rawBody = `{"__proto__":{"polluted":"top"},"unknownTop":true,"logs":[{"timestamp":"${timestamp}","level":"error","service":${JSON.stringify(service)},"message":"  Mixed CASE % _ \\\\ message  ","attributes":{"":"empty","emptyValue":"","unicode":"שלום-世界","number":3,"enabled":true,"__proto__":"prototype-value","constructor":"constructor-value","control":"\\u0001"},"unknownEntry":{"ignored":true}}]}`;
    const ingestion = await request("/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rawBody,
    });
    expectIngestionSuccess(ingestion, 1);

    const query = await request(`/logs?${encodeQuery({ service })}`);
    expect(query.response.status).toBe(200);
    const body = expectExactKeys(query.body, ["logs", "next_cursor"]);
    expect(body["next_cursor"]).toBeNull();
    const logs = body["logs"] as unknown[];
    expect(logs).toHaveLength(1);
    const log = expectLogShape(logs[0]);
    expect(log["timestamp"]).toBe(timestamp);
    expect(log["service"]).toBe(service);
    expect(log["message"]).toBe("  Mixed CASE % _ \\ message  ");
    const attributes = expectExactKeys(log["attributes"], [
      "",
      "emptyValue",
      "unicode",
      "number",
      "enabled",
      "__proto__",
      "constructor",
      "control",
    ]);
    expect(attributes[""]).toBe("empty");
    expect(attributes["emptyValue"]).toBe("");
    expect(attributes["unicode"]).toBe("שלום-世界");
    expect(attributes["number"]).toBe(3);
    expect(attributes["enabled"]).toBe(true);
    expect(attributes["__proto__"]).toBe("prototype-value");
    expect(Reflect.get(attributes, "constructor")).toBe("constructor-value");
    expect(attributes["control"]).toBe("\u0001");
    expect(Object.hasOwn(log, "unknownEntry")).toBe(false);
    expect(Object.hasOwn(body, "unknownTop")).toBe(false);

    const emptyValueFilter = new URLSearchParams({
      service,
      "attr.emptyValue": "",
    });
    const emptyValueMatch = await request(`/logs?${emptyValueFilter.toString()}`);
    expect(requireRecord(emptyValueMatch.body)["logs"] as unknown[]).toHaveLength(1);

    const offsetInstant = Date.now() - 4 * 60_000;
    const offsetTimestamp = new Date(offsetInstant + 2 * 60 * 60_000)
      .toISOString()
      .replace(/Z$/u, "+02:00");
    const canonicalTimestamp = new Date(offsetInstant).toISOString();
    const offsetService = `${runId}-offset`;
    expectIngestionSuccess(
      await request("/logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          logs: [ingestionEntry(offsetTimestamp, offsetService, "offset timestamp")],
        }),
      }),
      1,
    );
    const offsetQuery = await request(`/logs?${encodeQuery({ service: offsetService })}`);
    const offsetLog = expectLogShape((requireRecord(offsetQuery.body)["logs"] as unknown[])[0]);
    expect(offsetLog["timestamp"]).toBe(canonicalTimestamp);

    const nested = await request("/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"logs":[{"timestamp":"${timestamp}","level":"info","service":"${runId}-nested","message":"nested","attributes":{"__proto__":{"polluted":true},"constructor":{"polluted":true}}}]}`,
    });
    expect(nested.response.status).toBe(400);
    expect((requireRecord(nested.body)["rejected"] as unknown[]).length).toBe(1);

    const nul = await request("/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"logs":[{"timestamp":"${timestamp}","level":"info","service":"unsafe\\u0000service","message":"nul"}]}`,
    });
    expect(nul.response.status).toBe(400);
    expect(nul.text).toContain("U+0000");

    const pollutionProbe = await request("/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        logs: [ingestionEntry(timestamp, `${runId}-pollution-probe`, "ordinary")],
      }),
    });
    expectIngestionSuccess(pollutionProbe, 1);
  });

  it("implements partial batches, all-invalid batches, top-level errors, and malformed JSON safely", async () => {
    const timestamp = new Date(Date.now() - 120_000).toISOString();
    const service = `${runId}-mixed`;
    const future = new Date(Date.now() + 6 * 60_000).toISOString();
    const mixed = await request("/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        logs: [
          ingestionEntry(timestamp, service, "accepted"),
          ingestionEntry(timestamp, service, "bad-level", undefined, "debug"),
          { timestamp: future, level: "info", service, message: "future" },
          { timestamp, level: "critical", service, message: "bad level" },
          { timestamp, level: "info", service: "", message: "bad service" },
        ],
      }).replace('"level":"debug"', '"level":"DEBUG"'),
    });
    expect(mixed.response.status).toBe(200);
    const mixedBody = expectExactKeys(mixed.body, ["accepted", "rejected"]);
    expect(mixedBody["accepted"]).toBe(1);
    const rejected = mixedBody["rejected"] as { index: number; reason: string }[];
    expect(rejected.map(({ index }) => index)).toEqual([1, 2, 3, 4]);
    expect(rejected.every(({ reason }) => typeof reason === "string" && reason.length > 0)).toBe(
      true,
    );

    const persisted = await request(`/logs?${encodeQuery({ service })}`);
    expect(requireRecord(persisted.body)["logs"] as unknown[]).toHaveLength(1);

    const allInvalid = await request("/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logs: [null, [], { level: "info" }] }),
    });
    expect(allInvalid.response.status).toBe(400);
    expect(allInvalid.body).toMatchObject({ accepted: 0 });
    expect(requireRecord(allInvalid.body)["rejected"] as unknown[]).toHaveLength(3);

    const invalidAttributeValues = await request("/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        logs: [
          { timestamp, level: "info", service, message: "null", attributes: { value: null } },
          { timestamp, level: "info", service, message: "array", attributes: { value: [] } },
          {
            timestamp,
            level: "info",
            service,
            message: "nested",
            attributes: { value: { nested: true } },
          },
        ],
      }),
    });
    expect(invalidAttributeValues.response.status).toBe(400);
    expect(requireRecord(invalidAttributeValues.body)["accepted"]).toBe(0);
    expect(requireRecord(invalidAttributeValues.body)["rejected"] as unknown[]).toHaveLength(3);

    const levelsService = `${runId}-levels`;
    const levels = ["debug", "info", "warn", "error"] as const;
    expectIngestionSuccess(
      await request("/logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          logs: levels.map((level) =>
            ingestionEntry(timestamp, levelsService, `${level}-message`, undefined, level),
          ),
        }),
      }),
      4,
    );
    const levelLogs = requireRecord(
      (await request(`/logs?${encodeQuery({ service: levelsService })}`)).body,
    )["logs"] as unknown[];
    expect(new Set(levelLogs.map((item) => expectLogShape(item)["level"]))).toEqual(
      new Set(levels),
    );

    for (const invalid of [{}, { logs: "not-array" }, ingestionEntry(timestamp, service, "bare")]) {
      const result = await request("/logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invalid),
      });
      expect(result.response.status).toBe(400);
      expect(result.body).toEqual({ error: "Invalid ingestion request." });
    }

    const empty = await request("/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"logs":[]}',
    });
    expect(empty.response.status).toBe(400);
    expect(empty.body).toEqual({ accepted: 0, rejected: [] });

    const malformed = await request("/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"logs":["${runId}-malformed"`,
    });
    expectSafeError(malformed);
    expect(malformed.text).not.toContain(`${runId}-malformed`);
  });

  it("returns omitted attributes as an empty object and applies combined literal query filters", async () => {
    const baseTime = Date.now() - 5 * 60_000;
    const timestamp = new Date(baseTime).toISOString();
    const outside = new Date(baseTime + 2 * 60_000).toISOString();
    const service = `${runId}-query`;
    const attributes: Record<string, string | number | boolean> = Object.create(null) as Record<
      string,
      string | number | boolean
    >;
    Object.assign(attributes, {
      a: "one",
      b: "two",
      numeric: 3,
      enabled: true,
      zero: "0",
      negativeZero: "-0",
      "unicode-שלום": "ערך-世界",
      "backslash-\\key": "value-\\path",
      "": "empty-key",
      constructor: "constructor-data",
    });
    attributes["__proto__"] = "proto-data";
    const payload = {
      logs: [
        ingestionEntry(timestamp, service, "Needle % _ \\ MiXeD", attributes, "error"),
        ingestionEntry(outside, service, "outside range"),
        ingestionEntry(timestamp, `${service}-other`, "other service", { a: "one" }, "error"),
      ],
    };
    const ingestion = await request("/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expectIngestionSuccess(ingestion, 3);

    const until = new Date(baseTime + 60_000).toISOString();
    const parameters = new URLSearchParams({
      service,
      level: "error",
      since: timestamp,
      until,
      q: "% _ \\ mixed",
      "attr.a": "one",
      "attr.b": "two",
      "attr.numeric": "3",
      "attr.enabled": "true",
      "attr.zero": "0",
      "attr.negativeZero": "-0",
      "attr.unicode-שלום": "ערך-世界",
      "attr.backslash-\\key": "value-\\path",
      "attr.__proto__": "proto-data",
      "attr.constructor": "constructor-data",
    });
    const filtered = await request(`/logs?${parameters.toString()}`);
    expect(filtered.response.status).toBe(200);
    const filteredLogs = requireRecord(filtered.body)["logs"] as unknown[];
    expect(filteredLogs).toHaveLength(1);
    expect(expectLogShape(filteredLogs[0])["message"]).toBe("Needle % _ \\ MiXeD");

    const halfOpen = await request(
      `/logs?${encodeQuery({ service, since: timestamp, until: timestamp })}`,
    );
    expect(halfOpen.body).toEqual({ logs: [], next_cursor: null });

    const omitted = await request(
      `/logs?${encodeQuery({ service, q: "outside range", metadata: "ignored" })}`,
    );
    const omittedLog = expectLogShape((requireRecord(omitted.body)["logs"] as unknown[])[0]);
    expect(omittedLog["attributes"]).toEqual({});

    const withoutQ = await request(`/logs?${encodeQuery({ service })}`);
    const emptyQ = await request(`/logs?${encodeQuery({ service, q: "" })}`);
    expect(
      (requireRecord(emptyQ.body)["logs"] as unknown[]).map((item) => expectLogShape(item)["id"]),
    ).toEqual(
      (requireRecord(withoutQ.body)["logs"] as unknown[]).map((item) => expectLogShape(item)["id"]),
    );

    const noMatch = await request(`/logs?${encodeQuery({ service, "attr.a": "missing" })}`);
    expect(noMatch.body).toEqual({ logs: [], next_cursor: null });
  });

  it("rejects invalid and duplicate list parameters with safe HTTP 400 envelopes", async () => {
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    const later = new Date(Date.now()).toISOString();
    const cases = [
      "/logs?level=critical",
      "/logs?since=2026-08-10",
      `/logs?since=${encodeURIComponent(later)}&until=${encodeURIComponent(timestamp)}`,
      "/logs?limit=0",
      "/logs?limit=1001",
      "/logs?limit=1.5",
      "/logs?limit=%2B1",
      "/logs?limit=%201",
      "/logs?limit=1x",
      "/logs?service=a&service=a",
      "/logs?attr.key=a&attr.key=a",
      "/logs?attr.=value",
    ];
    for (const path of cases) {
      const result = await request(path);
      expectSafeError(result);
      expect(result.text).not.toContain("malformed-cursor-sentinel");
    }

    const malformedCursor = await request("/logs?cursor=malformed-cursor-sentinel");
    expect(malformedCursor.response.status).toBe(400);
    expect(malformedCursor.body).toEqual({ error: "Query parameter 'cursor' is invalid." });
    expect(malformedCursor.text).not.toContain("malformed-cursor-sentinel");

    expect((await request("/logs?limit=1")).response.status).toBe(200);
    expect((await request("/logs?limit=1000")).response.status).toBe(200);
  });

  it("provides opaque deterministic keyset pagination with the default limit", async () => {
    const timestamp = new Date(Date.now() - 3 * 60_000).toISOString();
    const service = `${runId}-pagination`;
    const expectedMessages = Array.from(
      { length: 101 },
      (_, index) => `${runId}-page-${String(index)}`,
    );
    const ingestion = await request("/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        logs: expectedMessages.map((message) => ingestionEntry(timestamp, service, message)),
      }),
    });
    expectIngestionSuccess(ingestion, 101);

    const first = await request(`/logs?${encodeQuery({ service })}`);
    const firstBody = expectExactKeys(first.body, ["logs", "next_cursor"]);
    const firstLogs = firstBody["logs"] as unknown[];
    expect(firstLogs).toHaveLength(100);
    expect(typeof firstBody["next_cursor"]).toBe("string");
    const firstIds = firstLogs.map((item) => String(expectLogShape(item)["id"]));
    expect(firstIds).toEqual([...firstIds].sort().reverse());

    const repeat = await request(`/logs?${encodeQuery({ service })}`);
    expect(
      (requireRecord(repeat.body)["logs"] as unknown[]).map((item) => expectLogShape(item)["id"]),
    ).toEqual(firstIds);

    const cursor = firstBody["next_cursor"] as string;
    const second = await request(`/logs?${encodeQuery({ service, cursor, limit: "1" })}`);
    const secondBody = expectExactKeys(second.body, ["logs", "next_cursor"]);
    expect(secondBody["logs"]).toHaveLength(1);
    expect(secondBody["next_cursor"]).toBeNull();

    const allLogs = [...firstLogs, ...(secondBody["logs"] as unknown[])];
    const ids = allLogs.map((item) => String(expectLogShape(item)["id"]));
    const messages = allLogs.map((item) => String(expectLogShape(item)["message"]));
    expect(new Set(ids).size).toBe(101);
    expect(new Set(messages)).toEqual(new Set(expectedMessages));

    const mismatch = await request(
      `/logs?${encodeQuery({ service: `${service}-different`, cursor })}`,
    );
    expect(mismatch.response.status).toBe(400);
    expect(mismatch.body).toEqual({ error: "Query parameter 'cursor' is invalid." });
    expect(mismatch.text).not.toContain(cursor);
    expect(mismatch.text).not.toContain(service);
  });

  it("aggregates supported UTC buckets, grouping, shared filters, ordering, and empty ranges", async () => {
    const hour = new Date();
    hour.setUTCMinutes(0, 0, 0);
    hour.setUTCHours(hour.getUTCHours() - 1);
    const at = (minutes: number): string =>
      new Date(hour.getTime() + minutes * 60_000).toISOString();
    const since = hour.toISOString();
    const until = new Date(hour.getTime() + 60 * 60_000).toISOString();
    const serviceA = `${runId}-aggregate-a`;
    const serviceB = `${runId}-aggregate-b`;
    const boundaryService = `${runId}-aggregate-boundary`;
    const marker = `${runId}-aggregation-marker`;
    const marked = (attributes: Record<string, string | number | boolean>) => ({
      ...attributes,
      contract_marker: marker,
    });
    const ingestion = await request("/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        logs: [
          ingestionEntry(
            at(1),
            serviceA,
            "Aggregate Needle % _ \\ MiXeD",
            marked({ region: "eu", enabled: true }),
            "error",
          ),
          ingestionEntry(
            at(2),
            serviceA,
            "ordinary",
            marked({ region: "eu", enabled: false }),
            "warn",
          ),
          ingestionEntry(
            at(6),
            serviceB,
            "ordinary",
            marked({ region: "us", enabled: true }),
            "info",
          ),
          ingestionEntry(
            at(31),
            serviceB,
            "ordinary",
            marked({ region: "us", enabled: true }),
            "info",
          ),
          ingestionEntry(since, boundaryService, "inclusive boundary", marked({ edge: "since" })),
          ingestionEntry(until, boundaryService, "exclusive boundary", marked({ edge: "until" })),
        ],
      }),
    });
    expectIngestionSuccess(ingestion, 6);

    const dayStart = new Date(
      Date.UTC(hour.getUTCFullYear(), hour.getUTCMonth(), hour.getUTCDate()),
    ).toISOString();
    const expectedStarts: Readonly<Record<string, readonly string[]>> = {
      "1m": [at(1), at(2)],
      "5m": [since],
      "1h": [since],
      "1d": [dayStart],
    };

    for (const bucket of ["1m", "5m", "1h", "1d"]) {
      const result = await request(
        `/logs/aggregate?${encodeQuery({ since, until, bucket, service: serviceA, "attr.contract_marker": marker })}`,
      );
      expect(result.response.status).toBe(200);
      const buckets = requireRecord(result.body)["buckets"] as unknown[];
      const total = buckets
        .map((item) => Number(requireRecord(item)["count"]))
        .reduce((sum, count) => sum + count, 0);
      expect(total).toBe(2);
      expect(buckets.map((item) => requireRecord(item)["start"])).toEqual(expectedStarts[bucket]);
      for (const item of buckets) {
        const row = expectExactKeys(item, ["start", "group", "count"]);
        expect(row["group"]).toBeNull();
        expect(Number.isSafeInteger(row["count"])).toBe(true);
      }
    }

    const multipleBuckets = await request(
      `/logs/aggregate?${encodeQuery({ since, until, bucket: "5m", "attr.contract_marker": marker })}`,
    );
    expect(multipleBuckets.body).toEqual({
      buckets: [
        { start: since, group: null, count: 3 },
        { start: at(5), group: null, count: 1 },
        { start: at(30), group: null, count: 1 },
      ],
    });

    const halfOpenBoundary = await request(
      `/logs/aggregate?${encodeQuery({ since, until, bucket: "1h", service: boundaryService, "attr.contract_marker": marker })}`,
    );
    expect(halfOpenBoundary.body).toEqual({
      buckets: [{ start: since, group: null, count: 1 }],
    });

    const grouped = await request(
      `/logs/aggregate?${encodeQuery({ since, until, bucket: "1h", group_by: "service", "attr.contract_marker": marker })}`,
    );
    expect(grouped.body).toEqual({
      buckets: [
        { start: since, group: serviceA, count: 2 },
        { start: since, group: serviceB, count: 2 },
        { start: since, group: boundaryService, count: 1 },
      ],
    });

    const byLevel = await request(
      `/logs/aggregate?${encodeQuery({ since, until, bucket: "1h", group_by: "level", service: serviceA, "attr.contract_marker": marker })}`,
    );
    expect(byLevel.body).toEqual({
      buckets: [
        { start: since, group: "error", count: 1 },
        { start: since, group: "warn", count: 1 },
      ],
    });

    const filtered = await request(
      `/logs/aggregate?${encodeQuery({ since, until, bucket: "5m", service: serviceA, level: "error", "attr.region": "eu", "attr.enabled": "true", "attr.contract_marker": marker, q: "% _ \\ mixed" })}`,
    );
    expect(filtered.body).toEqual({
      buckets: [{ start: hour.toISOString(), group: null, count: 1 }],
    });

    const equal = await request(
      `/logs/aggregate?${encodeQuery({ since, until: since, bucket: "1m", "attr.contract_marker": marker })}`,
    );
    expect(equal.body).toEqual({ buckets: [] });

    const noMatch = await request(
      `/logs/aggregate?${encodeQuery({ since, until, bucket: "1m", service: `${runId}-aggregate-no-match`, "attr.contract_marker": marker })}`,
    );
    expect(noMatch.body).toEqual({ buckets: [] });
  });

  it("rejects invalid aggregation parameters safely", async () => {
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    const until = new Date(Date.now()).toISOString();
    const cases = [
      `/logs/aggregate?${encodeQuery({ until, bucket: "1m" })}`,
      `/logs/aggregate?${encodeQuery({ since, bucket: "1m" })}`,
      `/logs/aggregate?${encodeQuery({ since, until })}`,
      `/logs/aggregate?${encodeQuery({ since: until, until: since, bucket: "1m" })}`,
      `/logs/aggregate?${encodeQuery({ since, until, bucket: "2m" })}`,
      `/logs/aggregate?${encodeQuery({ since: "not-a-timestamp", until, bucket: "1m" })}`,
      `/logs/aggregate?${encodeQuery({ since, until, bucket: "1m", group_by: "message" })}`,
      `/logs/aggregate?${encodeQuery({ since, until, bucket: "1m" })}&bucket=1m`,
    ];
    for (const path of cases) {
      expectSafeError(await request(path));
    }
  });

  it("supports a bounded concurrent ingestion correctness smoke", async () => {
    const service = `${runId}-concurrent`;
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    const batches = Array.from({ length: 8 }, (_, batch) =>
      Array.from(
        { length: 3 },
        (_, entry) => `${runId}-concurrent-${String(batch)}-${String(entry)}`,
      ),
    );
    const responses = await Promise.all(
      batches.map((messages) =>
        request("/logs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            logs: messages.map((message) => ingestionEntry(timestamp, service, message)),
          }),
        }),
      ),
    );
    for (const response of responses) {
      expectIngestionSuccess(response, 3);
    }

    const result = await request(`/logs?${encodeQuery({ service, limit: "1000" })}`);
    const logs = requireRecord(result.body)["logs"] as unknown[];
    const messages = logs.map((item) => String(expectLogShape(item)["message"]));
    expect(messages).toHaveLength(24);
    expect(new Set(messages).size).toBe(24);
  });
});
