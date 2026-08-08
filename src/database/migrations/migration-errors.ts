export class MigrationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMigrationFilenameError extends MigrationError {
  public constructor() {
    super("Migration directory contains an invalid filename.");
  }
}

export class DuplicateMigrationVersionError extends MigrationError {
  public constructor(version: number) {
    super(`Migration version ${String(version)} is duplicated.`);
  }
}

export class InvalidMigrationContentsError extends MigrationError {
  public constructor(version: number) {
    super(`Migration version ${String(version)} contains disallowed transaction control.`);
  }
}

export class MigrationFileReadError extends MigrationError {
  public constructor() {
    super("Migration files could not be read safely.");
  }
}

export class MigrationConnectionError extends MigrationError {
  public constructor() {
    super("The migration database connection failed.");
  }
}

export class MigrationOwnerStartupTimeoutError extends MigrationError {
  public constructor() {
    super("The migration database did not become ready before the startup deadline.");
  }
}

export class MigrationLockError extends MigrationError {
  public constructor() {
    super("The migration lock operation failed.");
  }
}

export class MigrationLockTimeoutError extends MigrationError {
  public constructor() {
    super("The migration lock was unavailable before the startup deadline.");
  }
}

export class MigrationInfrastructureError extends MigrationError {
  public constructor() {
    super("Migration history infrastructure could not be initialized.");
  }
}

export class MigrationHistoryReadError extends MigrationError {
  public constructor() {
    super("Migration history could not be validated.");
  }
}

export class MissingLocalMigrationError extends MigrationError {
  public constructor(version: number) {
    super(`Applied migration version ${String(version)} is missing locally.`);
  }
}

export class MigrationFilenameMismatchError extends MigrationError {
  public constructor(version: number) {
    super(`Applied migration version ${String(version)} has a filename mismatch.`);
  }
}

export class MigrationChecksumMismatchError extends MigrationError {
  public constructor(version: number) {
    super(`Applied migration version ${String(version)} has a checksum mismatch.`);
  }
}

export class MigrationExecutionError extends MigrationError {
  public constructor(version: number) {
    super(`Migration version ${String(version)} could not be applied.`);
  }
}
