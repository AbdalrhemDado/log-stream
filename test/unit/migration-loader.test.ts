import { describe, expect, it } from "vitest";

import {
  DuplicateMigrationVersionError,
  InvalidMigrationContentsError,
  InvalidMigrationFilenameError,
} from "../../src/database/migrations/migration-errors.js";
import {
  buildMigrationPlan,
  type MigrationSource,
} from "../../src/database/migrations/migration-loader.js";

const encoder = new TextEncoder();

function source(filename: string, sql = "SELECT 1;\n"): MigrationSource {
  return { filename, bytes: encoder.encode(sql) };
}

describe("buildMigrationPlan", () => {
  it("accepts the strict migration filename format", () => {
    const plan = buildMigrationPlan([source("0001_create_application_schema.sql")]);

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      version: 1,
      filename: "0001_create_application_schema.sql",
      sql: "SELECT 1;\n",
    });
  });

  it.each([
    "1_create_schema.sql",
    "0000_create_schema.sql",
    "0001-Create.sql",
    "0001_Create.sql",
    "0001_create schema.sql",
    "0001_create_schema.txt",
    "README.md",
  ])("rejects malformed migration filename %s", (filename) => {
    expect(() => buildMigrationPlan([source(filename)])).toThrow(InvalidMigrationFilenameError);
  });

  it("sorts versions numerically", () => {
    const plan = buildMigrationPlan([
      source("0010_tenth.sql"),
      source("0002_second.sql"),
      source("0001_first.sql"),
    ]);

    expect(plan.map((migration) => migration.version)).toEqual([1, 2, 10]);
  });

  it("rejects duplicate numeric versions", () => {
    expect(() =>
      buildMigrationPlan([source("0001_first.sql"), source("0001_duplicate.sql")]),
    ).toThrow(DuplicateMigrationVersionError);
  });

  it("computes SHA-256 from the exact bytes", () => {
    const [migration] = buildMigrationPlan([source("0001_first.sql")]);

    expect(migration?.checksum).toBe(
      "b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd",
    );
  });

  it.each([
    "BEGIN; SELECT 1;",
    "SELECT 1; COMMIT;",
    "START TRANSACTION;",
    "ROLLBACK WORK;",
    "END;",
    "END WORK;",
    "ABORT;",
    "ABORT TRANSACTION;",
    "PREPARE TRANSACTION 'migration';",
    "COMMIT PREPARED 'migration';",
    "ROLLBACK PREPARED 'migration';",
    "SAVEPOINT migration_step;",
    "RELEASE SAVEPOINT migration_step;",
    "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;",
    "SET LOCAL TRANSACTION READ ONLY;",
  ])("rejects migration-owned transaction control in %s", (sql) => {
    expect(() => buildMigrationPlan([source("0001_first.sql", sql)])).toThrow(
      InvalidMigrationContentsError,
    );
  });

  it("does not mistake comments, strings, or dollar-quoted blocks for transaction control", () => {
    const sql = `
-- COMMIT; END; ABORT;
/* outer /* nested END; */ PREPARE TRANSACTION 'comment'; SAVEPOINT comment_step; */
SELECT 'ROLLBACK PREPARED', "END", 'SET TRANSACTION', E'escaped\\' ABORT';
DO $$
BEGIN
  RAISE NOTICE 'inside block';
  SAVEPOINT nested_word;
  END;
END
$$;
`;

    expect(() => buildMigrationPlan([source("0001_first.sql", sql)])).not.toThrow();
  });
});
