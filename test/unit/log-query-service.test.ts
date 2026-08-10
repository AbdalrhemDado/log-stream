import { describe, expect, it, vi } from "vitest";

import { InternalDatabaseError } from "../../src/database/database-errors.js";
import type {
  ApiLogResponseItem,
  CanonicalUtcTimestamp,
  LogId,
} from "../../src/domain/log-entry.js";
import { encodeLogCursor } from "../../src/modules/query/cursor-codec.js";
import type {
  LogQueryPageRequest,
  LogQueryRepository,
} from "../../src/modules/query/log-query-repository.js";
import {
  createLogQueryService,
  type LogQueryService,
} from "../../src/modules/query/log-query-service.js";
import type { LogFilters } from "../../src/modules/query/query-parameter-parser.js";
import { BadRequestError, TransientServiceError } from "../../src/shared/app-error.js";

const TIMESTAMP = "2026-08-09T11:00:00.123456Z" as CanonicalUtcTimestamp;

function id(sequence: number): LogId {
  return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}` as LogId;
}

function log(sequence: number, timestamp: CanonicalUtcTimestamp = TIMESTAMP): ApiLogResponseItem {
  return {
    id: id(sequence),
    timestamp,
    level: "info",
    service: "checkout",
    message: `message ${String(sequence)}`,
    attributes: {} as ApiLogResponseItem["attributes"],
  };
}

function filters(overrides: Partial<LogFilters> = {}): LogFilters {
  return { attributes: [], ...overrides };
}

function harness(
  implementation: (request: LogQueryPageRequest) => Promise<readonly ApiLogResponseItem[]> = () =>
    Promise.resolve([]),
): { readonly service: LogQueryService; readonly findPage: ReturnType<typeof vi.fn> } {
  const findPage = vi.fn(implementation);
  const repository: LogQueryRepository = { findPage };
  return { service: createLogQueryService({ repository }), findPage };
}

describe("log query service validation", () => {
  it.each([
    {
      name: "invalid level",
      query: { level: "critical" },
      message: "Query parameter 'level' must be one of debug, info, warn, or error.",
    },
    {
      name: "duplicate service",
      query: { service: ["checkout", "checkout"] },
      message: "Query parameter 'service' must appear at most once.",
    },
    {
      name: "PostgreSQL-incompatible NUL",
      query: { service: "unsafe\u0000service" },
      message: "Query parameter 'service' must not contain U+0000.",
    },
    {
      name: "until earlier than since",
      query: {
        since: "2026-08-09T12:00:00.000Z",
        until: "2026-08-09T11:59:59.999Z",
      },
      message: "Query parameter 'until' must not be earlier than 'since'.",
    },
  ])("rejects $name before repository execution", async ({ query, message }) => {
    const { service, findPage } = harness();

    const operation = service.list(query);

    await expect(operation).rejects.toBeInstanceOf(BadRequestError);
    await expect(operation).rejects.toMatchObject({ statusCode: 400, publicMessage: message });
    expect(findPage).not.toHaveBeenCalled();
  });

  it("rejects a malformed cursor before repository execution", async () => {
    const { service, findPage } = harness();

    await expect(service.list({ cursor: "not-a-valid-cursor" })).rejects.toMatchObject({
      statusCode: 400,
      publicMessage: "Query parameter 'cursor' is invalid.",
    });
    expect(findPage).not.toHaveBeenCalled();
  });

  it("rejects a cursor bound to different filters before repository execution", async () => {
    const token = encodeLogCursor({ timestamp: TIMESTAMP, id: id(1) }, filters({ service: "a" }));
    const { service, findPage } = harness();

    await expect(service.list({ service: "b", cursor: token })).rejects.toMatchObject({
      statusCode: 400,
      publicMessage: "Query parameter 'cursor' is invalid.",
    });
    expect(findPage).not.toHaveBeenCalled();
  });

  it("passes normalized filters, limit, and decoded position to the repository", async () => {
    const normalizedFilters = filters({
      service: "checkout",
      since: "2026-08-09T10:00:00.000Z" as CanonicalUtcTimestamp,
    });
    const token = encodeLogCursor({ timestamp: TIMESTAMP, id: id(7) }, normalizedFilters);
    const { service, findPage } = harness();

    await service.list({
      service: "checkout",
      since: "2026-08-09T12:00:00+02:00",
      limit: "25",
      cursor: token,
    });

    expect(findPage).toHaveBeenCalledWith({
      filters: normalizedFilters,
      limit: 25,
      cursor: { timestamp: TIMESTAMP, id: id(7) },
    });
  });
});

describe("log query service page shaping", () => {
  it.each([
    { name: "empty", page: [], limit: "2" },
    { name: "short", page: [log(1)], limit: "2" },
    { name: "exact", page: [log(1), log(2)], limit: "2" },
  ])("returns a null cursor for an $name final page", async ({ page, limit }) => {
    const { service } = harness(() => Promise.resolve(page));

    await expect(service.list({ limit })).resolves.toEqual({ logs: page, next_cursor: null });
  });

  it("returns only the requested limit and encodes the last returned row", async () => {
    const page = [log(3), log(2), log(1)];
    const { service } = harness(() => Promise.resolve(page));

    const response = await service.list({ service: "checkout", limit: "2" });

    expect(response.logs).toEqual(page.slice(0, 2));
    expect(response.logs).not.toContain(page[2]);
    expect(response.next_cursor).toBe(
      encodeLogCursor(
        { timestamp: page[1]?.timestamp ?? TIMESTAMP, id: page[1]?.id ?? id(99) },
        filters({ service: "checkout" }),
      ),
    );
  });

  it("allows limit changes while continuing with the same filter-bound cursor", async () => {
    const pages = [
      [log(5), log(4)],
      [log(3), log(2), log(1)],
    ];
    let pageIndex = 0;
    const { service, findPage } = harness(() => Promise.resolve(pages[pageIndex++] ?? []));

    const first = await service.list({ service: "checkout", limit: "1" });
    const second = await service.list({
      service: "checkout",
      limit: "2",
      cursor: first.next_cursor ?? "",
    });

    expect(first.logs).toEqual([log(5)]);
    expect(second.logs).toEqual([log(3), log(2)]);
    expect(findPage).toHaveBeenNthCalledWith(2, {
      filters: filters({ service: "checkout" }),
      limit: 2,
      cursor: { timestamp: log(5).timestamp, id: log(5).id },
    });
  });

  it.each([
    { name: "internal", error: new InternalDatabaseError() },
    { name: "transient", error: new TransientServiceError() },
  ])("propagates an $name repository failure unchanged", async ({ error }) => {
    const { service } = harness(() => Promise.reject(error));

    await expect(service.list({})).rejects.toBe(error);
  });
});
