import { describe, expect, it, vi } from "vitest";

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
    "Connection terminated unexpectedly",
    "Connection terminated due to connection timeout",
  ])("maps the exact code-less driver message %s to TransientServiceError", (message) => {
    const translated = translateDatabaseError(new Error(message));

    expect(translated).toBeInstanceOf(TransientServiceError);
    expect(translated.message).toBe("Service temporarily unavailable.");
  });

  it.each([
    "connection terminated unexpectedly",
    "Connection terminated Unexpectedly",
    "Connection terminated unexpectedly ",
    "prefix Connection terminated unexpectedly",
    "Connection terminated unexpectedly suffix",
    "Connection terminated due to connection timeout.",
    "Connection terminated due to timeout",
  ])("keeps a near-match or case-variant message internal: %s", (message) => {
    expect(translateDatabaseError(new Error(message))).toBeInstanceOf(InternalDatabaseError);
  });

  it("does not classify an arbitrary object carrying an exact message as transient", () => {
    expect(
      translateDatabaseError({ message: "Connection terminated unexpectedly" }),
    ).toBeInstanceOf(InternalDatabaseError);
  });

  it("does not use an exact message to override an unknown code", () => {
    const source = new Error("Connection terminated unexpectedly") as Error & {
      code: string;
    };
    source.code = "XX999";

    expect(translateDatabaseError(source)).toBeInstanceOf(InternalDatabaseError);
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

  it("does not retain source details for an exact code-less transient error", () => {
    const source = new Error("Connection terminated unexpectedly") as Error & {
      connectionString: string;
      detail: string;
      query: string;
    };
    source.connectionString = "postgresql://owner:secret-password@database/logstream";
    source.detail = "hostile-submitted-value";
    source.query = "SELECT secret_column FROM secret_table";

    const translated = translateDatabaseError(source);
    const visible = `${String(translated)}\n${translated.stack ?? ""}`;

    expect(translated).toBeInstanceOf(TransientServiceError);
    expect(translated).not.toBe(source);
    expect("cause" in translated).toBe(false);
    expect(visible).not.toContain(source.connectionString);
    expect(visible).not.toContain(source.detail);
    expect(visible).not.toContain(source.query);
    expect(visible).not.toContain(source.message);
  });

  it("handles a hostile code getter without leaking or rethrowing its failure", () => {
    let calls = 0;
    const source = Object.defineProperty({}, "code", {
      get: () => {
        calls += 1;
        throw new Error("secret getter failure");
      },
    });

    const translated = translateDatabaseError(source);

    expect(translated).toBeInstanceOf(InternalDatabaseError);
    expect(calls).toBe(0);
    expect(String(translated)).not.toContain("secret getter failure");
  });

  it("does not execute hostile message getters or fall back past a hostile code getter", () => {
    let codeCalls = 0;
    let messageCalls = 0;
    const source = new Error("placeholder");
    Object.defineProperties(source, {
      code: {
        get: () => {
          codeCalls += 1;
          return undefined;
        },
      },
      message: {
        get: () => {
          messageCalls += 1;
          return "Connection terminated unexpectedly";
        },
      },
    });

    expect(translateDatabaseError(source)).toBeInstanceOf(InternalDatabaseError);
    expect(codeCalls).toBe(0);
    expect(messageCalls).toBe(0);
  });

  it("does not execute coercion hooks while inspecting an unrelated error", () => {
    const toString = vi.fn(() => "Connection terminated unexpectedly");
    const valueOf = vi.fn(() => "ECONNRESET");
    const toPrimitive = vi.fn(() => "ETIMEDOUT");
    const source = { toString, valueOf, [Symbol.toPrimitive]: toPrimitive };

    expect(translateDatabaseError(source)).toBeInstanceOf(InternalDatabaseError);
    expect(toString).not.toHaveBeenCalled();
    expect(valueOf).not.toHaveBeenCalled();
    expect(toPrimitive).not.toHaveBeenCalled();
  });
});
