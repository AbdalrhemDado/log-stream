import { BadRequestError } from "../../shared/app-error.js";
import { parseLogAggregationQuery } from "./aggregation-parameter-parser.js";
import type {
  LogAggregationBucket,
  LogAggregationRepository,
} from "./log-aggregation-repository.js";

export interface LogAggregationResponse {
  readonly buckets: readonly LogAggregationBucket[];
}

export interface LogAggregationService {
  aggregate(query: unknown): Promise<LogAggregationResponse>;
}

export interface LogAggregationServiceDependencies {
  readonly repository: LogAggregationRepository;
}

export function createLogAggregationService(
  dependencies: LogAggregationServiceDependencies,
): LogAggregationService {
  return {
    aggregate: async (query) => {
      const parsed = parseLogAggregationQuery(query);
      if (!parsed.ok) {
        throw new BadRequestError(parsed.error.error);
      }

      const buckets = await dependencies.repository.aggregate(parsed.value);
      return { buckets };
    },
  };
}
