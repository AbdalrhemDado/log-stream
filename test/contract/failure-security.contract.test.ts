import { describe, expect, it } from "vitest";

const EXPECTED_BASE_URL = "http://127.0.0.1:8080";
const RUN_ID_PATTERN = /^contract-[0-9]+-[a-z0-9]+$/u;
const REQUEST_TIMEOUT_MS = 20_000;
const CURRENT_BODY_GUARD_BYTES = 1_048_576;
const BODY_SENTINEL = "contract-body-secret-sentinel";
const SQL_TEXT = "'); DROP TABLE logstream.logs; --";
const SQL_FILTER = "' OR TRUE --";

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
    throw new Error("Failure-security contract environment is invalid.");
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
    throw new Error("Failure-security endpoint returned invalid JSON.");
  }
  return { response, body, text };
}

function assertRedactedError(result: HttpResult, submittedSentinels: readonly string[]): void {
  const body = expectExactKeys(result.body, ["error"]);
  expect(typeof body["error"]).toBe("string");
  const normalized = result.text.toLowerCase();
  for (const sentinel of submittedSentinels) {
    expect(normalized).not.toContain(sentinel.toLowerCase());
  }
  for (const pattern of [
    /postgres(?:ql)?:\/\//iu,
    /\b(?:database_url|migration_database_url|password|credential|authorization|cookie|token)\s*[:=]/iu,
    /\b(?:detail|hint|context|sqlstate)\s*:/iu,
    /\bpg_[a-z0-9_]+\b/iu,
    /\b(?:[0-9]{5}|[0-9]{2}[A-Z][0-9A-Z]{2}|[A-Z]{2}[0-9A-Z]{3})\b/u,
    /\b(?:select\b.+\bfrom|insert\s+into|update\b.+\bset|delete\s+from|drop\s+table|alter\s+table|create\s+table|truncate\s+table)\b/isu,
    /(?:\n|\\n)\s*at\s+(?:async\s+)?[^\n]+\([^\n]+:\d+:\d+\)/u,
    /[a-z]:(?:\\{1,2})(?:users|workspace|app)(?:\\{1,2})[^\s"']+/iu,
    /\/(?:app|workspace|home|usr\/src|users)\/[^\s"']+/iu,
    /\b[0-9a-f]{12,64}\b/u,
  ]) {
    expect(result.text).not.toMatch(pattern);
  }
}

function entry(
  timestamp: string,
  service: string,
  message: string,
  attributes: Record<string, string | number | boolean> = {},
): Record<string, unknown> {
  return { timestamp, level: "info", service, message, attributes };
}

function expectIngestion(result: HttpResult, accepted: number): void {
  expect(result.response.status).toBe(200);
  expect(result.body).toEqual({ accepted, rejected: [] });
}

function logsFrom(result: HttpResult): Record<string, unknown>[] {
  expect(result.response.status).toBe(200);
  const body = expectExactKeys(result.body, ["logs", "next_cursor"]);
  expect(Array.isArray(body["logs"])).toBe(true);
  return body["logs"] as Record<string, unknown>[];
}

describe.skipIf(!contractEnabled)("failure and security public contract", () => {
  it("keeps injection-shaped ingestion strings as data and rejects typed injection values", async () => {
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    const service = `${runId}-injection-${SQL_TEXT}`;
    const message = `${BODY_SENTINEL}-${runId} ${SQL_TEXT}`;
    const attributes = Object.create(null) as Record<string, string>;
    const attributeKey = `key${SQL_TEXT}`;
    const attributeValue = `value${SQL_TEXT}`;
    attributes[attributeKey] = attributeValue;

    const accepted = await request("/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logs: [entry(timestamp, service, message, attributes)] }),
    });
    expectIngestion(accepted, 1);

    const listed = await request(`/logs?${new URLSearchParams({ service }).toString()}`);
    const logs = logsFrom(listed);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.["service"]).toBe(service);
    expect(logs[0]?.["message"]).toBe(message);
    expect(requireRecord(logs[0]?.["attributes"])[attributeKey]).toBe(attributeValue);

    const invalidCases = [
      {
        timestamp: `${runId}-${SQL_TEXT}`,
        level: "info",
        service: `${runId}-invalid-timestamp`,
        message: "invalid timestamp",
      },
      {
        timestamp,
        level: SQL_TEXT,
        service: `${runId}-invalid-level`,
        message: "invalid level",
      },
    ];
    for (const invalid of invalidCases) {
      const result = await request("/logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ logs: [invalid] }),
      });
      expect(result.response.status).toBe(400);
      expect(requireRecord(result.body)["accepted"]).toBe(0);
      expect(Array.isArray(requireRecord(result.body)["rejected"])).toBe(true);
      expect(result.text).not.toContain(SQL_TEXT);
      expect(result.text).not.toMatch(/postgres(?:ql)?:\/\//iu);
    }
  });

  it("keeps every list and aggregation input category parameterized or whitelisted", async () => {
    const timestamp = new Date(Date.now() - 2 * 60_000).toISOString();
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    const until = new Date(Date.now() + 60_000).toISOString();
    const service = `${runId}-security-canary`;
    const marker = `${runId}-security-marker`;
    expectIngestion(
      await request("/logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          logs: [entry(timestamp, service, "ordinary canary", { contract_marker: marker })],
        }),
      }),
      1,
    );

    const literalQueries = [
      `/logs?${new URLSearchParams({ service: SQL_FILTER }).toString()}`,
      `/logs?${new URLSearchParams({ q: SQL_FILTER }).toString()}`,
      `/logs?${new URLSearchParams({ [`attr.key${SQL_TEXT}`]: SQL_FILTER }).toString()}`,
    ];
    for (const path of literalQueries) {
      expect(logsFrom(await request(path))).toEqual([]);
    }

    const invalidListQueries = [
      `/logs?${new URLSearchParams({ level: SQL_TEXT }).toString()}`,
      `/logs?${new URLSearchParams({ since: SQL_TEXT }).toString()}`,
      `/logs?${new URLSearchParams({ until: SQL_TEXT }).toString()}`,
      `/logs?${new URLSearchParams({ limit: SQL_TEXT }).toString()}`,
      `/logs?${new URLSearchParams({ cursor: SQL_TEXT }).toString()}`,
    ];
    for (const path of invalidListQueries) {
      const result = await request(path);
      expect(result.response.status).toBe(400);
      assertRedactedError(result, [SQL_TEXT]);
    }

    const literalAggregation = await request(
      `/logs/aggregate?${new URLSearchParams({
        since,
        until,
        bucket: "1m",
        service: SQL_FILTER,
        [`attr.key${SQL_TEXT}`]: SQL_FILTER,
        q: SQL_FILTER,
      }).toString()}`,
    );
    expect(literalAggregation.response.status).toBe(200);
    expect(literalAggregation.body).toEqual({ buckets: [] });

    const invalidAggregationQueries = [
      { since: SQL_TEXT, until, bucket: "1m" },
      { since, until: SQL_TEXT, bucket: "1m" },
      { since, until, bucket: SQL_TEXT },
      { since, until, bucket: "1m", group_by: SQL_TEXT },
      { since, until, bucket: "1m", level: SQL_TEXT },
    ];
    for (const parameters of invalidAggregationQueries) {
      const result = await request(`/logs/aggregate?${new URLSearchParams(parameters).toString()}`);
      expect(result.response.status).toBe(400);
      assertRedactedError(result, [SQL_TEXT]);
    }

    const postHostilityService = `${runId}-post-hostility-canary`;
    const postHostilityMarker = `${runId}-post-hostility-marker`;
    expectIngestion(
      await request("/logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          logs: [
            entry(timestamp, postHostilityService, "post-hostility canary", {
              contract_marker: postHostilityMarker,
            }),
          ],
        }),
      }),
      1,
    );
    const canaryList = await request(
      `/logs?${new URLSearchParams({
        service: postHostilityService,
        "attr.contract_marker": postHostilityMarker,
      }).toString()}`,
    );
    const canaryLogs = logsFrom(canaryList);
    expect(canaryLogs).toHaveLength(1);
    expect(canaryLogs[0]?.["message"]).toBe("post-hostility canary");
    const canaryAggregate = await request(
      `/logs/aggregate?${new URLSearchParams({
        since,
        until,
        bucket: "1m",
        service: postHostilityService,
        "attr.contract_marker": postHostilityMarker,
      }).toString()}`,
    );
    expect(canaryAggregate.response.status).toBe(200);
    const buckets = requireRecord(canaryAggregate.body)["buckets"] as unknown[];
    expect(buckets).toHaveLength(1);
    expect(requireRecord(buckets[0])["count"]).toBe(1);
    expect((await request("/health")).response.status).toBe(200);
  });

  it("records bounded behavior below and just above the current framework body guard", async () => {
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    const service = `${runId}-moderate-body`;
    const messages = Array.from(
      { length: 100 },
      (_, index) => `${runId}-moderate-${String(index)}-${"x".repeat(128)}`,
    );
    const moderate = await request("/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        logs: messages.map((message) => entry(timestamp, service, message)),
      }),
    });
    expectIngestion(moderate, messages.length);
    const reconciled = await request(
      `/logs?${new URLSearchParams({ service, limit: "1000" }).toString()}`,
    );
    expect(logsFrom(reconciled)).toHaveLength(messages.length);

    const rejectedService = `${runId}-current-body-guard`;
    const oversizedBody = JSON.stringify({
      logs: [
        entry(
          timestamp,
          rejectedService,
          `${runId}-oversized-${"x".repeat(CURRENT_BODY_GUARD_BYTES)}`,
        ),
      ],
    });
    expect(Buffer.byteLength(oversizedBody, "utf8")).toBeGreaterThan(CURRENT_BODY_GUARD_BYTES);
    const oversized = await request("/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversizedBody,
    });
    expect(oversized.response.status).toBe(413);
    expect(oversized.body).toEqual({ error: "Invalid request." });
    assertRedactedError(oversized, [rejectedService]);
    expect(
      logsFrom(
        await request(`/logs?${new URLSearchParams({ service: rejectedService }).toString()}`),
      ),
    ).toEqual([]);
    expect((await request("/health")).response.status).toBe(200);
  });
});
