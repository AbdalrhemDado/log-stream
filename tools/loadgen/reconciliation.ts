import { assertValidComposeProjectName } from "./config.js";
import { requireSuccessfulCommand, SafeCommandError } from "./commands.js";
import type { CommandRunner, RowReconciliation } from "./types.js";

const RUN_ID_PATTERN = /^lg-v1-[a-f0-9]{8}-[0-9]{8}t[0-9]{9}z$/u;
const COUNT_SQL = String.raw`
SELECT count(*)
FROM logstream.logs
WHERE attributes_search @> jsonb_build_object('loadgen_run_id', :'run_id');
`;

function parseCount(output: string): number {
  const value = output.trim();
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new SafeCommandError("PostgreSQL reconciliation returned an invalid count.");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    throw new SafeCommandError("PostgreSQL reconciliation count exceeds the safe range.");
  }
  return count;
}

export function buildReconciliationInvocation(
  project: string,
  runId: string,
): {
  readonly command: "docker";
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly stdin: string;
} {
  assertValidComposeProjectName(project);
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new SafeCommandError("Run marker failed reconciliation validation.");
  }
  return {
    command: "docker",
    args: [
      "compose",
      "-p",
      project,
      "exec",
      "--no-TTY",
      "postgres",
      "psql",
      "--username",
      "postgres",
      "--dbname",
      "logstream",
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--set",
      `run_id=${runId}`,
    ],
    timeoutMs: 30_000,
    stdin: COUNT_SQL,
  };
}

export async function countRunRows(
  runner: CommandRunner,
  project: string,
  runId: string,
): Promise<number> {
  const result = await requireSuccessfulCommand(
    runner,
    buildReconciliationInvocation(project, runId),
    "PostgreSQL row reconciliation failed.",
  );
  return parseCount(result.stdout);
}

export function reconcileRows(
  preExistingRows: number,
  expectedRows: number,
  observedRows: number,
): RowReconciliation {
  if (
    ![preExistingRows, expectedRows, observedRows].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  ) {
    throw new SafeCommandError("Row reconciliation inputs are invalid.");
  }
  const delta = observedRows - expectedRows;
  return {
    preExistingRows,
    expectedRows,
    observedRows,
    delta,
    passed: preExistingRows === 0 && delta === 0,
  };
}
