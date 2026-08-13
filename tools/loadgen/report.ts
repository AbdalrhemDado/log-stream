import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { LoadGeneratorReport } from "./types.js";

const FORBIDDEN_REPORT_PATTERNS = [
  /postgres(?:ql)?:\/\//iu,
  /\bDATABASE_URL\b/iu,
  /\bMIGRATION_DATABASE_URL\b/iu,
  /\b(?:password|passwd|secret|api[_-]?key)\s*[:=]/iu,
  /https?:\/\/[^\s/@]+:[^\s/@]+@/iu,
] as const;

export interface ReportFileSystem {
  readonly mkdir: typeof mkdir;
  readonly writeFile: typeof writeFile;
  readonly rename: typeof rename;
  readonly rm: typeof rm;
}

const defaultFileSystem: ReportFileSystem = { mkdir, writeFile, rename, rm };

export function serializeReport(report: LoadGeneratorReport): string {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (FORBIDDEN_REPORT_PATTERNS.some((pattern) => pattern.test(serialized))) {
    throw new Error("Report serialization rejected potentially sensitive content.");
  }
  return serialized;
}

export async function publishReportAtomically(
  outputPath: string,
  report: LoadGeneratorReport,
  fileSystem: ReportFileSystem = defaultFileSystem,
): Promise<void> {
  const directory = dirname(outputPath);
  const temporaryPath = join(
    directory,
    `.${basename(outputPath)}.${String(process.pid)}.${Date.now().toString(36)}.tmp`,
  );
  const serialized = serializeReport(report);
  await fileSystem.mkdir(directory, { recursive: true });
  try {
    await fileSystem.writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
    await fileSystem.rename(temporaryPath, outputPath);
  } catch (error) {
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
