import type { ValidatedLogEntry } from "./log-entry.js";

export type UntrustedIngestionBody = unknown;
export type UntrustedLogEntry = unknown;

export interface RejectionItem {
  readonly index: number;
  readonly reason: string;
}

export type ValidationResult =
  | {
      readonly ok: true;
      readonly value: ValidatedLogEntry;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export interface IngestionResponse {
  readonly accepted: number;
  readonly rejected: readonly RejectionItem[];
}
