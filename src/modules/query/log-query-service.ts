import type { ApiLogResponseItem } from "../../domain/log-entry.js";
import { BadRequestError } from "../../shared/app-error.js";
import { decodeLogCursor, encodeLogCursor } from "./cursor-codec.js";
import type { LogQueryRepository } from "./log-query-repository.js";
import { parseLogListQuery } from "./query-parameter-parser.js";

export interface LogQueryResponse {
  readonly logs: readonly ApiLogResponseItem[];
  readonly next_cursor: string | null;
}

export interface LogQueryService {
  list(query: unknown): Promise<LogQueryResponse>;
}

export interface LogQueryServiceDependencies {
  readonly repository: LogQueryRepository;
}

export function createLogQueryService(dependencies: LogQueryServiceDependencies): LogQueryService {
  return {
    list: async (query) => {
      const parsed = parseLogListQuery(query);
      if (!parsed.ok) {
        throw new BadRequestError(parsed.error.error);
      }

      let cursor;
      if (parsed.value.cursor !== undefined) {
        const decoded = decodeLogCursor(parsed.value.cursor, parsed.value.filters);
        if (!decoded.ok) {
          throw new BadRequestError(decoded.error.error);
        }
        cursor = decoded.value;
      }

      const page = await dependencies.repository.findPage({
        filters: parsed.value.filters,
        limit: parsed.value.limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const hasMore = page.length > parsed.value.limit;
      const logs = page.slice(0, parsed.value.limit);
      const lastLog = logs.at(-1);

      return {
        logs,
        next_cursor:
          hasMore && lastLog !== undefined
            ? encodeLogCursor(
                { timestamp: lastLog.timestamp, id: lastLog.id },
                parsed.value.filters,
              )
            : null,
      };
    },
  };
}
