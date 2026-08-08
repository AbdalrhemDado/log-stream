export type AppErrorStatus = 400 | 503;

export abstract class AppError extends Error {
  public readonly statusCode: AppErrorStatus;
  public readonly publicMessage: string;
  public readonly retryAfterSeconds: number | undefined;

  protected constructor(
    statusCode: AppErrorStatus,
    publicMessage: string,
    retryAfterSeconds?: number,
  ) {
    super(publicMessage);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class BadRequestError extends AppError {
  public constructor(publicMessage: string) {
    super(400, publicMessage);
  }
}

export class TransientServiceError extends AppError {
  public constructor() {
    super(503, "Service temporarily unavailable.", 30);
  }
}
