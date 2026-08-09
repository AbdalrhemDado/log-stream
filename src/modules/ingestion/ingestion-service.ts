import { randomUUID } from "node:crypto";

import { normalizeAttributes } from "../../domain/attribute-normalizer.js";
import type {
  IngestionResponse,
  RejectionItem,
  UntrustedIngestionBody,
} from "../../domain/ingestion.js";
import { validateLogEntry } from "../../domain/log-entry-validator.js";
import type { LogId, LogInsertionRecord } from "../../domain/log-entry.js";
import { BadRequestError } from "../../shared/app-error.js";
import type { IngestionRepository } from "./ingestion-repository.js";

const INVALID_INGESTION_REQUEST_MESSAGE = "Invalid ingestion request.";

export interface IngestionService {
  ingest(body: UntrustedIngestionBody): Promise<IngestionResponse>;
}

export interface IngestionServiceDependencies {
  readonly repository: IngestionRepository;
  readonly clock?: () => number;
  readonly generateId?: () => LogId;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function readLogs(body: UntrustedIngestionBody): readonly unknown[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError(INVALID_INGESTION_REQUEST_MESSAGE);
  }

  if (!hasOwn(body, "logs")) {
    throw new BadRequestError(INVALID_INGESTION_REQUEST_MESSAGE);
  }

  const logs: unknown = Reflect.get(body, "logs");
  if (!Array.isArray(logs)) {
    throw new BadRequestError(INVALID_INGESTION_REQUEST_MESSAGE);
  }

  return logs;
}

function generateLogId(): LogId {
  return randomUUID() as LogId;
}

export function createIngestionService(
  dependencies: IngestionServiceDependencies,
): IngestionService {
  const clock = dependencies.clock ?? Date.now;
  const generateId = dependencies.generateId ?? generateLogId;

  return {
    ingest: async (body) => {
      const logs = readLogs(body);
      const referenceTimeMs = clock();
      const records: LogInsertionRecord[] = [];
      const rejected: RejectionItem[] = [];

      for (const [index, input] of logs.entries()) {
        const result = validateLogEntry(input, referenceTimeMs);

        if (!result.ok) {
          rejected.push({ index, reason: result.reason });
          continue;
        }

        records.push({
          ...result.value,
          id: generateId(),
          attributesSearch: normalizeAttributes(result.value.attributes),
        });
      }

      if (records.length > 0) {
        await dependencies.repository.insert(records);
      }

      return {
        accepted: records.length,
        rejected,
      };
    },
  };
}
