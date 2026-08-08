export interface MigrationFile {
  readonly version: number;
  readonly filename: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly filename: string;
  readonly checksum: string;
}

export interface MigrationQueryResult {
  readonly rows: readonly unknown[];
}

export interface MigrationDatabase {
  query(sql: string, parameters?: unknown[]): Promise<MigrationQueryResult>;
}

export interface MigrationOwnerConnection extends MigrationDatabase {
  connect(): Promise<void>;
  end(): Promise<void>;
}

export interface MigrationRunResult {
  readonly appliedVersions: readonly number[];
}

export interface MigrationClock {
  now(): number;
  sleep(delayMs: number): Promise<void>;
  runWithTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T>;
}
