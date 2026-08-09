import { describe, expect, it } from "vitest";

import {
  InternalDatabaseError,
  translateDatabaseError,
} from "../../src/database/database-errors.js";
import { TransientServiceError } from "../../src/shared/app-error.js";

describe("translateDatabaseError", () => {
  it.each([
    "08000",
    "08001",
    "08003",
    "08006",
    "08007",
    "57P01",
    "57P02",
    "57P03",
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
    "ETIMEDOUT",
  ])("maps the explicitly allowed transient code %s to TransientServiceError", (code) => {
    const translated = translateDatabaseError({ code, message: "raw connection detail" });

    expect(translated).toBeInstanceOf(TransientServiceError);
    expect(translated.message).toBe("Service temporarily unavailable.");
  });

  it.each([
    ["unique constraint", "23505"],
    ["check constraint", "23514"],
    ["serialization", "40001"],
    ["programming", "42601"],
    ["authentication or configuration", "28P01"],
    ["unknown", "XX999"],
  ])("maps a %s failure with code %s to InternalDatabaseError", (_name, code) => {
    const translated = translateDatabaseError({ code });

    expect(translated).toBeInstanceOf(InternalDatabaseError);
    expect(translated).not.toBeInstanceOf(TransientServiceError);
  });

  it.each([undefined, null, "failure", 42, {}, { code: 57_003 }])(
    "safely handles an error without a trusted string code: %o",
    (source) => {
      expect(translateDatabaseError(source)).toBeInstanceOf(InternalDatabaseError);
    },
  );

  it("does not retain source messages, SQL, credentials, record values, or the original error", () => {
    const secrets = [
      "duplicate key value violates unique constraint",
      "INSERT INTO logstream.logs",
      "postgresql://owner:secret-password@database/logstream",
      "hostile-service-value",
    ];
    const source = new Error(secrets.join(" | ")) as Error & { code: string; detail: string };
    source.code = "23505";
    source.detail = secrets.join(" | ");

    const translated = translateDatabaseError(source);
    const visible = `${String(translated)}\n${translated.stack ?? ""}`;

    expect(translated).toBeInstanceOf(InternalDatabaseError);
    expect(translated).not.toBe(source);
    expect("cause" in translated).toBe(false);
    for (const secret of secrets) {
      expect(visible).not.toContain(secret);
    }
  });

  it("handles a hostile code getter without leaking or rethrowing its failure", () => {
    const source = Object.defineProperty({}, "code", {
      get: () => {
        throw new Error("secret getter failure");
      },
    });

    const translated = translateDatabaseError(source);

    expect(translated).toBeInstanceOf(InternalDatabaseError);
    expect(String(translated)).not.toContain("secret getter failure");
  });
});
