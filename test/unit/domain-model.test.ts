import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  AttributeValue,
  NormalizedSearchAttributes,
  OriginalAttributes,
} from "../../src/domain/attributes.js";
import type {
  IngestionResponse,
  RejectionItem,
  UntrustedIngestionBody,
  UntrustedLogEntry,
  ValidationResult,
} from "../../src/domain/ingestion.js";
import {
  LOG_LEVELS,
  type ApiLogResponseItem,
  type CanonicalUtcTimestamp,
  type LogId,
  type LogInsertionRecord,
  type LogLevel,
  type NormalizedLogEntry,
  type ValidatedLogEntry,
} from "../../src/domain/log-entry.js";

describe("ingestion domain model", () => {
  it("publishes exactly the four supported log levels", () => {
    expect(LOG_LEVELS).toEqual(["debug", "info", "warn", "error"]);
    expectTypeOf<typeof LOG_LEVELS>().toEqualTypeOf<readonly ["debug", "info", "warn", "error"]>();
    expectTypeOf<LogLevel>().toEqualTypeOf<(typeof LOG_LEVELS)[number]>();
  });

  it("keeps incoming transport values unknown", () => {
    expectTypeOf<UntrustedIngestionBody>().toBeUnknown();
    expectTypeOf<UntrustedLogEntry>().toBeUnknown();
  });

  it("limits attribute values and distinguishes normalized attributes", () => {
    expectTypeOf<AttributeValue>().toEqualTypeOf<string | number | boolean>();
    expectTypeOf<null>().not.toExtend<AttributeValue>();
    expectTypeOf<readonly unknown[]>().not.toExtend<AttributeValue>();
    expectTypeOf<{ readonly nested: string }>().not.toExtend<AttributeValue>();

    expectTypeOf<NormalizedSearchAttributes[string]>().toEqualTypeOf<string>();
    expectTypeOf<Record<string, AttributeValue>>().not.toExtend<OriginalAttributes>();
    expectTypeOf<Record<string, string>>().not.toExtend<NormalizedSearchAttributes>();
  });

  it("narrows validation outcomes through the ok discriminator", () => {
    const describeResult = (result: ValidationResult): string => {
      if (result.ok) {
        expectTypeOf(result.value).toEqualTypeOf<ValidatedLogEntry>();
        return result.value.message;
      }

      expectTypeOf(result.reason).toEqualTypeOf<string>();
      return result.reason;
    };

    expectTypeOf(describeResult).returns.toBeString();
  });

  it("models rejection and ingestion response shapes", () => {
    expectTypeOf<RejectionItem>().toEqualTypeOf<{
      readonly index: number;
      readonly reason: string;
    }>();
    expectTypeOf<IngestionResponse["accepted"]>().toEqualTypeOf<number>();
    expectTypeOf<IngestionResponse["rejected"]>().toEqualTypeOf<readonly RejectionItem[]>();
  });

  it("requires attributes on API response items", () => {
    type ResponseWithoutAttributes = Omit<ApiLogResponseItem, "attributes">;

    expectTypeOf<ApiLogResponseItem["attributes"]>().toEqualTypeOf<OriginalAttributes>();
    expectTypeOf<ResponseWithoutAttributes>().not.toExtend<ApiLogResponseItem>();
  });

  it("keeps branded IDs and timestamps string-compatible but distinct", () => {
    expectTypeOf<LogId>().toExtend<string>();
    expectTypeOf<CanonicalUtcTimestamp>().toExtend<string>();
    expectTypeOf<string>().not.toExtend<LogId>();
    expectTypeOf<string>().not.toExtend<CanonicalUtcTimestamp>();
    expectTypeOf<LogId>().not.toExtend<CanonicalUtcTimestamp>();
    expectTypeOf<CanonicalUtcTimestamp>().not.toExtend<LogId>();
  });

  it("keeps each domain boundary readonly", () => {
    const assertReadonly = (
      original: OriginalAttributes,
      search: NormalizedSearchAttributes,
      validated: ValidatedLogEntry,
      normalized: NormalizedLogEntry,
      insertion: LogInsertionRecord,
      replacementId: LogId,
      responseItem: ApiLogResponseItem,
      rejection: RejectionItem,
      response: IngestionResponse,
    ): void => {
      // @ts-expect-error Original attribute records are readonly.
      original.key = "changed";
      // @ts-expect-error Normalized attribute records are readonly.
      search.key = "changed";
      // @ts-expect-error Validated entries are readonly.
      validated.message = "changed";
      // @ts-expect-error Normalized entries are readonly.
      normalized.attributesSearch = search;
      // @ts-expect-error Insertion records are readonly.
      insertion.id = replacementId;
      // @ts-expect-error API response items are readonly.
      responseItem.attributes = original;
      // @ts-expect-error Rejection items are readonly.
      rejection.reason = "changed";
      // @ts-expect-error Ingestion responses are readonly.
      response.rejected = [];
    };

    expectTypeOf(assertReadonly).returns.toBeVoid();
  });
});
