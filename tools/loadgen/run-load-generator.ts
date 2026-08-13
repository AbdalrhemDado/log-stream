import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseLoadGeneratorOptions } from "./config.js";
import { runManagedLoadGenerator } from "./orchestrator.js";

export function isDirectEsmEntry(moduleUrl: string, argumentPath: string | undefined): boolean {
  return argumentPath !== undefined && moduleUrl === pathToFileURL(resolve(argumentPath)).href;
}

export async function runLoadGenerator(arguments_: readonly string[]): Promise<number> {
  try {
    const options = parseLoadGeneratorOptions(arguments_);
    const report = await runManagedLoadGenerator(options);
    const measured = report.measuredIngestion;
    const aggregation = report.aggregation;
    process.stdout.write(
      [
        `Load generator outcome: ${report.outcome}`,
        `Confirmed measured accepted rows: ${String(measured?.counters.confirmedAcceptedRows ?? 0)}`,
        `Measured accepted rows/second: ${String(measured?.confirmedAcceptedRowsPerSecond ?? "unavailable")}`,
        `Aggregation successful samples: ${String(aggregation?.requestLatencySuccessful.sampleCount ?? 0)}`,
        `Aggregation p95 ms: ${String(aggregation?.requestLatencySuccessful.p95 ?? "unavailable")}`,
        `Report: ${options.outputPath}`,
      ].join("\n") + "\n",
    );
    return report.outcome === "passed" ? 0 : 1;
  } catch {
    process.stderr.write("Load generator failed. See a published report when available.\n");
    return 1;
  }
}

if (isDirectEsmEntry(import.meta.url, process.argv[1])) {
  process.exitCode = await runLoadGenerator(process.argv.slice(2));
}
