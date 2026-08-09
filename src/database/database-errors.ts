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

const INTERNAL_DATABASE_MESSAGE = "Database operation failed.";

export class InternalDatabaseError extends Error {
  public constructor() {
    super(INTERNAL_DATABASE_MESSAGE);
    this.name = "InternalDatabaseError";
  }
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  try {
    const code: unknown = Reflect.get(error, "code");
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

export function translateDatabaseError(
  error: unknown,
): InternalDatabaseError | TransientServiceError {
  const code = readErrorCode(error);

  if (code !== undefined && TRANSIENT_DATABASE_CODES.has(code)) {
    return new TransientServiceError();
  }

  return new InternalDatabaseError();
}
