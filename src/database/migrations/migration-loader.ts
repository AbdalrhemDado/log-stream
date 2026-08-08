import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import {
  DuplicateMigrationVersionError,
  InvalidMigrationContentsError,
  InvalidMigrationFilenameError,
  MigrationError,
  MigrationFileReadError,
} from "./migration-errors.js";
import type { MigrationFile } from "./migration-types.js";

const MIGRATION_FILENAME_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const TRANSACTION_CONTROL_PATTERN =
  /(?:^|;)\s*(?:BEGIN(?:\s+(?:WORK|TRANSACTION))?|START\s+TRANSACTION|END(?:\s+(?:WORK|TRANSACTION))?|ABORT(?:\s+(?:WORK|TRANSACTION))?|PREPARE\s+TRANSACTION|COMMIT(?:\s+(?:WORK|TRANSACTION|PREPARED))?|ROLLBACK(?:\s+(?:WORK|TRANSACTION|PREPARED))?|SAVEPOINT|RELEASE\s+SAVEPOINT|SET(?:\s+LOCAL)?\s+TRANSACTION)\b/imu;

export interface MigrationSource {
  readonly filename: string;
  readonly bytes: Uint8Array;
}

function maskSqlStringsAndComments(sql: string): string {
  let masked = "";
  let index = 0;

  while (index < sql.length) {
    const current = sql.charAt(index);
    const next = sql.charAt(index + 1);

    if (current === "-" && next === "-") {
      const end = sql.indexOf("\n", index + 2);
      if (end === -1) {
        return `${masked}${" ".repeat(sql.length - index)}`;
      }
      masked += " ".repeat(end - index);
      index = end;
      continue;
    }

    if (current === "/" && next === "*") {
      let commentDepth = 1;
      let cursor = index + 2;
      while (cursor < sql.length && commentDepth > 0) {
        if (sql.charAt(cursor) === "/" && sql.charAt(cursor + 1) === "*") {
          commentDepth += 1;
          cursor += 2;
          continue;
        }
        if (sql.charAt(cursor) === "*" && sql.charAt(cursor + 1) === "/") {
          commentDepth -= 1;
          cursor += 2;
          continue;
        }
        cursor += 1;
      }
      if (commentDepth > 0) {
        return `${masked}${" ".repeat(sql.length - index)}`;
      }
      masked += sql.slice(index, cursor).replaceAll(/[^\n]/gu, " ");
      index = cursor;
      continue;
    }

    if (current === "'" || current === '"') {
      const quote = current;
      const prefix = sql.charAt(index - 1);
      const beforePrefix = sql.charAt(index - 2);
      const usesBackslashEscapes =
        quote === "'" && (prefix === "E" || prefix === "e") && !/[A-Za-z0-9_$]/u.test(beforePrefix);
      masked += " ";
      index += 1;
      while (index < sql.length) {
        if (usesBackslashEscapes && sql.charAt(index) === "\\") {
          masked += " ".repeat(Math.min(2, sql.length - index));
          index += 2;
          continue;
        }
        if (sql.charAt(index) === quote) {
          if (sql.charAt(index + 1) === quote) {
            masked += "  ";
            index += 2;
            continue;
          }
          masked += " ";
          index += 1;
          break;
        }
        masked += sql.charAt(index) === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    if (current === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index))?.[0];
      if (tag !== undefined) {
        const end = sql.indexOf(tag, index + tag.length);
        if (end === -1) {
          return `${masked}${" ".repeat(sql.length - index)}`;
        }
        const length = end + tag.length - index;
        masked += sql.slice(index, index + length).replaceAll(/[^\n]/gu, " ");
        index += length;
        continue;
      }
    }

    masked += current;
    index += 1;
  }

  return masked;
}

function parseVersion(filename: string): number {
  const match = MIGRATION_FILENAME_PATTERN.exec(filename);
  if (match === null) {
    throw new InvalidMigrationFilenameError();
  }

  const versionText = match[1];
  if (versionText === undefined) {
    throw new InvalidMigrationFilenameError();
  }

  const version = Number(versionText);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new InvalidMigrationFilenameError();
  }

  return version;
}

export function buildMigrationPlan(sources: readonly MigrationSource[]): readonly MigrationFile[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const versions = new Set<number>();
  const migrations = sources.map((source): MigrationFile => {
    const version = parseVersion(source.filename);
    if (versions.has(version)) {
      throw new DuplicateMigrationVersionError(version);
    }
    versions.add(version);

    let sql: string;
    try {
      sql = decoder.decode(source.bytes);
    } catch {
      throw new MigrationFileReadError();
    }

    if (TRANSACTION_CONTROL_PATTERN.test(maskSqlStringsAndComments(sql))) {
      throw new InvalidMigrationContentsError(version);
    }

    return {
      version,
      filename: source.filename,
      checksum: createHash("sha256").update(source.bytes).digest("hex"),
      sql,
    };
  });

  return migrations.toSorted((left, right) => left.version - right.version);
}

export async function loadMigrations(directory: string): Promise<readonly MigrationFile[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const sources = await Promise.all(
      entries.map(async (entry): Promise<MigrationSource> => {
        if (!entry.isFile()) {
          throw new InvalidMigrationFilenameError();
        }

        return {
          filename: entry.name,
          bytes: await readFile(`${directory}/${entry.name}`),
        };
      }),
    );

    return buildMigrationPlan(sources);
  } catch (error: unknown) {
    if (error instanceof MigrationError) {
      throw error;
    }
    throw new MigrationFileReadError();
  }
}
