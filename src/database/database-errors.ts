import { TransientServiceError } from "../shared/app-error.js";

const TRANSIENT_DATABASE_CODES = new Set([
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08007", // transaction_resolution_unknown
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
]);

const TRANSIENT_CODELESS_DATABASE_MESSAGES = new Set([
  "Connection terminated unexpectedly",
  "Connection terminated due to connection timeout",
]);

const INTERNAL_DATABASE_MESSAGE = "Database operation failed.";

export class InternalDatabaseError extends Error {
  public constructor() {
    super(INTERNAL_DATABASE_MESSAGE);
    this.name = "InternalDatabaseError";
  }
}

type OwnStringProperty =
  | { readonly kind: "absent" }
  | { readonly kind: "unsafe" }
  | { readonly kind: "value"; readonly value: string };

function readOwnStringProperty(error: unknown, property: string): OwnStringProperty {
  if (typeof error !== "object" || error === null) {
    return { kind: "absent" };
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, property);

    if (descriptor === undefined) {
      return { kind: "absent" };
    }

    if (!("value" in descriptor) || typeof descriptor.value !== "string") {
      return { kind: "unsafe" };
    }

    return { kind: "value", value: descriptor.value };
  } catch {
    return { kind: "unsafe" };
  }
}

function isErrorInstance(error: unknown): error is Error {
  try {
    return error instanceof Error;
  } catch {
    return false;
  }
}

export function translateDatabaseError(
  error: unknown,
): InternalDatabaseError | TransientServiceError {
  const code = readOwnStringProperty(error, "code");

  if (code.kind === "value") {
    return TRANSIENT_DATABASE_CODES.has(code.value)
      ? new TransientServiceError()
      : new InternalDatabaseError();
  }

  if (code.kind === "unsafe" || !isErrorInstance(error)) {
    return new InternalDatabaseError();
  }

  const message = readOwnStringProperty(error, "message");

  if (message.kind === "value" && TRANSIENT_CODELESS_DATABASE_MESSAGES.has(message.value)) {
    return new TransientServiceError();
  }

  return new InternalDatabaseError();
}
