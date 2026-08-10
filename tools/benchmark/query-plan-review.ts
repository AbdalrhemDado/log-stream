const DEFAULT_SEED = 20_260_810;
const DEFAULT_ROWS = 1_000_000;
const DEFAULT_OUTPUT = "docs/performance/results/query-plan-baseline.json";
const MAX_SEED = 4_294_967_295;
const MAX_ROWS = 1_000_000;
const UNSIGNED_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const DAILY_PARTITION_PATTERN = /^logs_[0-9]{8}$/u;

const TASK_6_3_PATHS = new Set([
  "docs/performance/query-plan-review.md",
  "docs/performance/results/query-plan-baseline.json",
  "package.json",
  "test/unit/query-plan-review.test.ts",
  "tools/benchmark/query-plan-review.ts",
  "tools/benchmark/run-query-plan-review.ts",
]);

export const EXPLAIN_PREFIX = "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, SETTINGS) ";

export class QueryPlanConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "QueryPlanConfigurationError";
  }
}

export class QueryPlanVerificationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "QueryPlanVerificationError";
  }
}

export interface QueryPlanOptions {
  readonly seed: number;
  readonly rows: number;
  readonly output: string;
}

export interface GitSourceState {
  readonly workingTreeDirty: boolean;
  readonly task63PathsUncommitted: boolean;
  readonly sourceState: string;
}

export interface QueryScenario {
  readonly id:
    | "recent-unfiltered-list"
    | "service-time-list"
    | "level-time-list"
    | "attribute-filtered-list"
    | "literal-message-search-list"
    | "primary-aggregation";
  readonly kind: "list" | "aggregation";
  readonly query: Readonly<Record<string, string>>;
  readonly description: string;
}

export interface BufferEvidence {
  readonly sharedHit: number;
  readonly sharedRead: number;
  readonly sharedDirtied: number;
  readonly sharedWritten: number;
  readonly localHit: number;
  readonly localRead: number;
  readonly localDirtied: number;
  readonly localWritten: number;
  readonly tempRead: number;
  readonly tempWritten: number;
}

export interface PlanNodeEvidence {
  readonly path: string;
  readonly nodeType: string;
  readonly relationName?: string;
  readonly alias?: string;
  readonly indexName?: string;
  readonly plannedRows: number;
  readonly actualRows: number;
  readonly actualLoops: number;
  readonly estimateToActualRatio: number | null;
  readonly subplansRemoved: number;
  readonly buffers: BufferEvidence;
  readonly sortKey?: readonly string[];
  readonly sortMethod?: string;
  readonly sortSpaceUsedKb?: number;
  readonly sortSpaceType?: string;
  readonly incrementalSort?: {
    readonly presortedKey?: readonly string[];
    readonly fullSortGroups?: Readonly<Record<string, unknown>>;
    readonly preSortedGroups?: Readonly<Record<string, unknown>>;
  };
  readonly groupKey?: readonly string[];
  readonly strategy?: string;
  readonly hashAggBatches?: number;
  readonly peakMemoryUsageKb?: number;
  readonly diskUsageKb?: number;
  readonly hasFilter: boolean;
  readonly hasIndexCondition: boolean;
  readonly hasRecheckCondition: boolean;
}

export interface ExplainDocument extends Readonly<Record<string, unknown>> {
  readonly Plan: Record<string, unknown>;
  readonly "Planning Time": number;
  readonly "Execution Time": number;
  readonly Planning: Record<string, unknown>;
  readonly Settings: Record<string, unknown>;
}

export interface PlanSummary {
  readonly topLevelNodeType: string;
  readonly planningTimeMs: number;
  readonly executionTimeMs: number;
  readonly rootActualRows: number;
  readonly rootBuffers: BufferEvidence;
  readonly planningBuffers: BufferEvidence;
  readonly nodes: readonly PlanNodeEvidence[];
  readonly scanTypes: readonly string[];
  readonly partitionsPlanned: readonly string[];
  readonly partitionsExecuted: readonly string[];
  readonly defaultPartitionPlanned: boolean;
  readonly defaultPartitionExecuted: boolean;
  readonly incrementalSortOccurred: boolean;
  readonly subplansRemoved: number;
  readonly spillDetected: boolean;
}

export interface ExplainQueryDatabaseResult {
  readonly rows: readonly unknown[];
}

export interface ExplainQueryDatabase {
  query(sql: string, parameters?: unknown[]): Promise<ExplainQueryDatabaseResult>;
}

export interface CapturedExplainQuery {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly document: ExplainDocument;
  readonly summary: PlanSummary;
}

export interface ExplainCapture {
  readonly database: ExplainQueryDatabase;
  readCapture(): CapturedExplainQuery;
}

export interface DatasetExpectedCounts {
  readonly rows: number;
  readonly emptyAttributes: number;
  readonly service007: number;
  readonly errorLevel: number;
  readonly tenant000123: number;
  readonly messageMarker: number;
}

export interface DatasetObservedCounts extends DatasetExpectedCounts {
  readonly defaultPartitionRows: number;
  readonly minimumTimestamp: string;
  readonly maximumTimestamp: string;
  readonly partitionCount: number;
}

export interface DatasetExpectedBoundaries {
  readonly minimumTimestamp: string;
  readonly maximumTimestamp: string;
  readonly partitionCount: number;
}

export interface QueryPlanReport {
  readonly schemaVersion: 1;
  readonly run: {
    readonly timestampUtc: string;
    readonly baseCommit: string;
    readonly branch: string;
    readonly workingTreeDirty: boolean;
    readonly task63PathsUncommitted: boolean;
    readonly sourceState: string;
  };
  readonly environment: Readonly<Record<string, unknown>>;
  readonly dockerControls: {
    readonly nanoCpus: 1_000_000_000;
    readonly memoryBytes: 1_073_741_824;
    readonly autoRemove: true;
    readonly persistentMountCount: 0;
  };
  readonly applicationProcess: {
    readonly constrainedToCompanyLimit: false;
    readonly note: string;
  };
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly postgresSettings: Readonly<Record<string, string>>;
  readonly database: Readonly<Record<string, unknown>>;
  readonly queries: readonly Readonly<Record<string, unknown>>[];
  readonly verifiedObservations: readonly string[];
  readonly limitations: readonly string[];
  readonly unverifiedRequirements: readonly string[];
}

function parseNumericOption(name: "seed" | "rows", value: string): number {
  if (!UNSIGNED_INTEGER_PATTERN.test(value)) {
    throw new QueryPlanConfigurationError(`The --${name} value is invalid.`);
  }

  const parsed = Number(value);
  const maximum = name === "seed" ? MAX_SEED : MAX_ROWS;
  const minimum = name === "seed" ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new QueryPlanConfigurationError(`The --${name} value is invalid.`);
  }
  return parsed;
}

function readOptionValue(arguments_: readonly string[], index: number, flag: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new QueryPlanConfigurationError(`The ${flag} flag requires a value.`);
  }
  return value;
}

export function parseQueryPlanOptions(arguments_: readonly string[]): QueryPlanOptions {
  let seed = DEFAULT_SEED;
  let rows = DEFAULT_ROWS;
  let output = DEFAULT_OUTPUT;
  const seen = new Set<string>();

  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    if (!flag?.startsWith("--")) {
      throw new QueryPlanConfigurationError("Unexpected positional benchmark argument.");
    }
    if (flag !== "--seed" && flag !== "--rows" && flag !== "--output") {
      throw new QueryPlanConfigurationError("An unknown query-plan flag was provided.");
    }
    if (seen.has(flag)) {
      throw new QueryPlanConfigurationError(`The ${flag} flag must appear at most once.`);
    }
    seen.add(flag);
    const value = readOptionValue(arguments_, index, flag);

    switch (flag) {
      case "--seed":
        seed = parseNumericOption("seed", value);
        break;
      case "--rows":
        rows = parseNumericOption("rows", value);
        break;
      case "--output":
        if (value.length === 0 || value.trim() !== value || !value.endsWith(".json")) {
          throw new QueryPlanConfigurationError("The --output value is invalid.");
        }
        output = value;
        break;
      default:
        throw new QueryPlanConfigurationError("An unknown query-plan flag was provided.");
    }
  }

  return { seed, rows, output };
}

function porcelainPath(line: string): string | undefined {
  if (line.length < 4) {
    return undefined;
  }
  const path = line.slice(3).trim();
  const renameSeparator = " -> ";
  return path.includes(renameSeparator) ? path.slice(path.lastIndexOf(renameSeparator) + 4) : path;
}

export function describeGitSourceState(statusOutput: string): GitSourceState {
  const paths = statusOutput
    .split(/\r?\n/u)
    .map(porcelainPath)
    .filter((path): path is string => path !== undefined);
  const task63PathsUncommitted = paths.some((path) => TASK_6_3_PATHS.has(path));
  const workingTreeDirty = paths.length > 0;

  return {
    workingTreeDirty,
    task63PathsUncommitted,
    sourceState: task63PathsUncommitted
      ? "Task 6.3 query-plan paths have uncommitted changes."
      : workingTreeDirty
        ? "The working tree is dirty, but Task 6.3 query-plan paths are committed."
        : "The working tree is clean and Task 6.3 query-plan paths are committed.",
  };
}

function offsetIso(referenceTimeMs: number, offsetMs: number): string {
  const value = new Date(referenceTimeMs - offsetMs);
  if (!Number.isFinite(value.getTime())) {
    throw new QueryPlanConfigurationError("The reference timestamp is invalid.");
  }
  return value.toISOString();
}

export function createQueryScenarios(referenceTimeMs: number): readonly QueryScenario[] {
  const until = offsetIso(referenceTimeMs, 0);
  const since24Hours = offsetIso(referenceTimeMs, 24 * 60 * 60 * 1_000);
  const since7Days = offsetIso(referenceTimeMs, 7 * 24 * 60 * 60 * 1_000);

  return [
    {
      id: "recent-unfiltered-list",
      kind: "list",
      query: { since: since24Hours, until, limit: "100" },
      description: "Newest 24-hour page without a dimension filter.",
    },
    {
      id: "service-time-list",
      kind: "list",
      query: { service: "service-007", since: since7Days, until, limit: "100" },
      description: "Selective service filter over seven days.",
    },
    {
      id: "level-time-list",
      kind: "list",
      query: { level: "error", since: since7Days, until, limit: "100" },
      description: "Low-cardinality level filter over seven days.",
    },
    {
      id: "attribute-filtered-list",
      kind: "list",
      query: { "attr.tenant_id": "tenant-000123", since: since7Days, until, limit: "100" },
      description: "Normalized JSONB attribute containment over seven days.",
    },
    {
      id: "literal-message-search-list",
      kind: "list",
      query: { q: "nEeDlE_%\\pAtH", since: since7Days, until, limit: "100" },
      description: "Literal mixed-case message search containing SQL wildcard characters.",
    },
    {
      id: "primary-aggregation",
      kind: "aggregation",
      query: {
        since: since24Hours,
        until,
        bucket: "5m",
        group_by: "service",
      },
      description: "Representative 24-hour, five-minute aggregation grouped by service.",
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownNumber(record: Record<string, unknown>, key: string, fallback = 0): number {
  const value = record[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new QueryPlanVerificationError("PostgreSQL returned an invalid EXPLAIN plan.");
  }
  return value;
}

function ownString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new QueryPlanVerificationError("PostgreSQL returned an invalid EXPLAIN plan.");
  }
  return value;
}

function ownStringArray(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new QueryPlanVerificationError("PostgreSQL returned an invalid EXPLAIN plan.");
  }
  return value;
}

function ownRecord(
  record: Record<string, unknown>,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new QueryPlanVerificationError("PostgreSQL returned an invalid EXPLAIN plan.");
  }
  return value;
}

function readBuffers(record: Record<string, unknown>): BufferEvidence {
  return {
    sharedHit: ownNumber(record, "Shared Hit Blocks"),
    sharedRead: ownNumber(record, "Shared Read Blocks"),
    sharedDirtied: ownNumber(record, "Shared Dirtied Blocks"),
    sharedWritten: ownNumber(record, "Shared Written Blocks"),
    localHit: ownNumber(record, "Local Hit Blocks"),
    localRead: ownNumber(record, "Local Read Blocks"),
    localDirtied: ownNumber(record, "Local Dirtied Blocks"),
    localWritten: ownNumber(record, "Local Written Blocks"),
    tempRead: ownNumber(record, "Temp Read Blocks"),
    tempWritten: ownNumber(record, "Temp Written Blocks"),
  };
}

export function calculateEstimateRatio(plannedRows: number, actualRows: number): number | null {
  if (
    !Number.isFinite(plannedRows) ||
    !Number.isFinite(actualRows) ||
    plannedRows < 0 ||
    actualRows < 0
  ) {
    throw new QueryPlanVerificationError("Plan row estimates are invalid.");
  }
  if (actualRows === 0) {
    return plannedRows === 0 ? 1 : null;
  }
  return plannedRows / actualRows;
}

export function parseExplainRows(rows: readonly unknown[]): ExplainDocument {
  if (rows.length !== 1 || !isRecord(rows[0])) {
    throw new QueryPlanVerificationError("PostgreSQL returned an invalid EXPLAIN result.");
  }
  const raw = rows[0]["QUERY PLAN"];
  if (!Array.isArray(raw) || raw.length !== 1 || !isRecord(raw[0])) {
    throw new QueryPlanVerificationError("PostgreSQL returned an invalid EXPLAIN result.");
  }
  const document = raw[0];
  const plan = document["Plan"];
  const planningTime = document["Planning Time"];
  const executionTime = document["Execution Time"];
  if (
    !isRecord(plan) ||
    typeof planningTime !== "number" ||
    !Number.isFinite(planningTime) ||
    planningTime < 0 ||
    typeof executionTime !== "number" ||
    !Number.isFinite(executionTime) ||
    executionTime < 0
  ) {
    throw new QueryPlanVerificationError("PostgreSQL returned an invalid EXPLAIN result.");
  }
  const planning = document["Planning"];
  const settings = document["Settings"];
  if (!isRecord(planning)) {
    throw new QueryPlanVerificationError("PostgreSQL returned an invalid EXPLAIN result.");
  }
  if (!isRecord(settings)) {
    throw new QueryPlanVerificationError("PostgreSQL returned an invalid EXPLAIN result.");
  }
  return document as ExplainDocument;
}

interface WalkState {
  readonly nodes: PlanNodeEvidence[];
  readonly scanTypes: Set<string>;
  readonly partitionsPlanned: Set<string>;
  readonly partitionsExecuted: Set<string>;
  subplansRemoved: number;
  spillDetected: boolean;
  incrementalSortOccurred: boolean;
}

function walkPlanNode(node: Record<string, unknown>, path: string, state: WalkState): void {
  const nodeType = ownString(node, "Node Type");
  if (nodeType === undefined) {
    throw new QueryPlanVerificationError("PostgreSQL returned an invalid EXPLAIN plan.");
  }
  const plannedRows = ownNumber(node, "Plan Rows");
  const actualRows = ownNumber(node, "Actual Rows");
  const actualLoops = ownNumber(node, "Actual Loops");
  const relationName = ownString(node, "Relation Name");
  const alias = ownString(node, "Alias");
  const indexName = ownString(node, "Index Name");
  const sortMethod = ownString(node, "Sort Method");
  const sortSpaceType = ownString(node, "Sort Space Type");
  const sortKey = ownStringArray(node, "Sort Key");
  const presortedKey = ownStringArray(node, "Presorted Key");
  const fullSortGroups = ownRecord(node, "Full-sort Groups");
  const preSortedGroups = ownRecord(node, "Pre-sorted Groups");
  const groupKey = ownStringArray(node, "Group Key");
  const strategy = ownString(node, "Strategy");
  const hashAggBatches =
    node["HashAgg Batches"] === undefined ? undefined : ownNumber(node, "HashAgg Batches");
  const diskUsageKb = node["Disk Usage"] === undefined ? undefined : ownNumber(node, "Disk Usage");
  const buffers = readBuffers(node);
  const subplansRemoved = ownNumber(node, "Subplans Removed");
  state.subplansRemoved += subplansRemoved;

  if (nodeType.includes("Scan")) {
    state.scanTypes.add(nodeType);
  }
  if (nodeType === "Incremental Sort") {
    state.incrementalSortOccurred = true;
  }
  if (
    relationName !== undefined &&
    (DAILY_PARTITION_PATTERN.test(relationName) || relationName === "logs_default")
  ) {
    state.partitionsPlanned.add(relationName);
    if (actualLoops > 0) {
      state.partitionsExecuted.add(relationName);
    }
  }
  if (
    sortMethod?.toLowerCase().includes("external") === true ||
    (hashAggBatches !== undefined && hashAggBatches > 1) ||
    (diskUsageKb !== undefined && diskUsageKb > 0) ||
    buffers.tempRead > 0 ||
    buffers.tempWritten > 0
  ) {
    state.spillDetected = true;
  }

  state.nodes.push({
    path,
    nodeType,
    ...(relationName === undefined ? {} : { relationName }),
    ...(alias === undefined ? {} : { alias }),
    ...(indexName === undefined ? {} : { indexName }),
    plannedRows,
    actualRows,
    actualLoops,
    estimateToActualRatio: calculateEstimateRatio(plannedRows, actualRows),
    subplansRemoved,
    buffers,
    ...(sortKey === undefined ? {} : { sortKey }),
    ...(sortMethod === undefined ? {} : { sortMethod }),
    ...(node["Sort Space Used"] === undefined
      ? {}
      : { sortSpaceUsedKb: ownNumber(node, "Sort Space Used") }),
    ...(sortSpaceType === undefined ? {} : { sortSpaceType }),
    ...(presortedKey === undefined && fullSortGroups === undefined && preSortedGroups === undefined
      ? {}
      : {
          incrementalSort: {
            ...(presortedKey === undefined ? {} : { presortedKey }),
            ...(fullSortGroups === undefined ? {} : { fullSortGroups }),
            ...(preSortedGroups === undefined ? {} : { preSortedGroups }),
          },
        }),
    ...(groupKey === undefined ? {} : { groupKey }),
    ...(strategy === undefined ? {} : { strategy }),
    ...(hashAggBatches === undefined ? {} : { hashAggBatches }),
    ...(node["Peak Memory Usage"] === undefined
      ? {}
      : { peakMemoryUsageKb: ownNumber(node, "Peak Memory Usage") }),
    ...(diskUsageKb === undefined ? {} : { diskUsageKb }),
    hasFilter: typeof node["Filter"] === "string",
    hasIndexCondition: typeof node["Index Cond"] === "string",
    hasRecheckCondition: typeof node["Recheck Cond"] === "string",
  });

  const children = node["Plans"];
  if (children === undefined) {
    return;
  }
  if (!Array.isArray(children) || !children.every(isRecord)) {
    throw new QueryPlanVerificationError("PostgreSQL returned an invalid EXPLAIN plan.");
  }
  children.forEach((child, index) => {
    walkPlanNode(child, `${path}.${String(index)}`, state);
  });
}

export function summarizeExplainDocument(document: ExplainDocument): PlanSummary {
  const state: WalkState = {
    nodes: [],
    scanTypes: new Set(),
    partitionsPlanned: new Set(),
    partitionsExecuted: new Set(),
    subplansRemoved: 0,
    spillDetected: false,
    incrementalSortOccurred: false,
  };
  walkPlanNode(document.Plan, "0", state);
  const root = state.nodes[0];
  if (root === undefined) {
    throw new QueryPlanVerificationError("PostgreSQL returned an empty EXPLAIN plan.");
  }
  return {
    topLevelNodeType: root.nodeType,
    planningTimeMs: document["Planning Time"],
    executionTimeMs: document["Execution Time"],
    rootActualRows: root.actualRows,
    rootBuffers: root.buffers,
    planningBuffers: readBuffers(document.Planning),
    nodes: state.nodes,
    scanTypes: [...state.scanTypes].sort(),
    partitionsPlanned: [...state.partitionsPlanned].sort(),
    partitionsExecuted: [...state.partitionsExecuted].sort(),
    defaultPartitionPlanned: state.partitionsPlanned.has("logs_default"),
    defaultPartitionExecuted: state.partitionsExecuted.has("logs_default"),
    incrementalSortOccurred: state.incrementalSortOccurred,
    subplansRemoved: state.subplansRemoved,
    spillDetected: state.spillDetected,
  };
}

export function createExplainCapture(database: ExplainQueryDatabase): ExplainCapture {
  let capture: CapturedExplainQuery | undefined;
  return {
    database: {
      query: async (sql, parameters = []) => {
        if (capture !== undefined) {
          throw new QueryPlanVerificationError("A scenario attempted more than one plan capture.");
        }
        const result = await database.query(`${EXPLAIN_PREFIX}${sql}`, parameters);
        const document = parseExplainRows(result.rows);
        capture = {
          sql,
          parameters: [...parameters],
          document,
          summary: summarizeExplainDocument(document),
        };
        return { rows: [] };
      },
    },
    readCapture: () => {
      if (capture === undefined) {
        throw new QueryPlanVerificationError("A scenario did not produce an EXPLAIN plan.");
      }
      return capture;
    },
  };
}

export function calculateExpectedDatasetCounts(rows: number, seed: number): DatasetExpectedCounts {
  if (
    !Number.isSafeInteger(rows) ||
    rows < 1 ||
    rows > MAX_ROWS ||
    !Number.isSafeInteger(seed) ||
    seed < 0 ||
    seed > MAX_SEED
  ) {
    throw new QueryPlanConfigurationError("Dataset configuration is invalid.");
  }
  let emptyAttributes = 0;
  let service007 = 0;
  let errorLevel = 0;
  let tenant000123 = 0;
  let messageMarker = 0;
  for (let ordinal = 0; ordinal < rows; ordinal += 1) {
    const shifted = BigInt(ordinal) + BigInt(seed);
    const empty = shifted % 10n === 0n;
    if (empty) emptyAttributes += 1;
    if (shifted % 100n === 7n) service007 += 1;
    if (shifted % 4n === 3n) errorLevel += 1;
    if (!empty && shifted % 1_000n === 123n) tenant000123 += 1;
    if (shifted % 1_000n === 0n) messageMarker += 1;
  }
  return { rows, emptyAttributes, service007, errorLevel, tenant000123, messageMarker };
}

function formatMicrosecondTimestamp(epochMicroseconds: number): string {
  if (!Number.isSafeInteger(epochMicroseconds)) {
    throw new QueryPlanConfigurationError("Dataset timestamp calculation is invalid.");
  }
  const secondMilliseconds = Math.floor(epochMicroseconds / 1_000_000) * 1_000;
  const fractionMicroseconds = epochMicroseconds - secondMilliseconds * 1_000;
  return new Date(secondMilliseconds)
    .toISOString()
    .replace(".000Z", `.${String(fractionMicroseconds).padStart(6, "0")}Z`);
}

export function calculateExpectedDatasetBoundaries(
  rows: number,
  referenceTimeMs: number,
): DatasetExpectedBoundaries {
  if (
    !Number.isSafeInteger(rows) ||
    rows < 1 ||
    rows > MAX_ROWS ||
    !Number.isSafeInteger(referenceTimeMs)
  ) {
    throw new QueryPlanConfigurationError("Dataset timestamp calculation is invalid.");
  }
  const windowMicroseconds = 30 * 24 * 60 * 60 * 1_000_000;
  const referenceMicroseconds = referenceTimeMs * 1_000;
  const minimumMicroseconds = referenceMicroseconds - windowMicroseconds;
  const maximumMicroseconds = referenceMicroseconds - Math.round(windowMicroseconds / rows);
  const dayMicroseconds = 24 * 60 * 60 * 1_000_000;
  const partitionCount =
    Math.floor(maximumMicroseconds / dayMicroseconds) -
    Math.floor(minimumMicroseconds / dayMicroseconds) +
    1;
  return {
    minimumTimestamp: formatMicrosecondTimestamp(minimumMicroseconds),
    maximumTimestamp: formatMicrosecondTimestamp(maximumMicroseconds),
    partitionCount,
  };
}

export function assertDatasetReconciliation(
  expected: DatasetExpectedCounts,
  observed: DatasetObservedCounts,
): void {
  for (const key of [
    "rows",
    "emptyAttributes",
    "service007",
    "errorLevel",
    "tenant000123",
    "messageMarker",
  ] as const) {
    if (expected[key] !== observed[key]) {
      throw new QueryPlanVerificationError("Dataset reconciliation failed.");
    }
  }
  if (
    observed.defaultPartitionRows !== 0 ||
    observed.partitionCount < 1 ||
    observed.minimumTimestamp.length === 0 ||
    observed.maximumTimestamp.length === 0
  ) {
    throw new QueryPlanVerificationError("Dataset reconciliation failed.");
  }
}

export function assertDatasetBoundaryReconciliation(
  expected: DatasetExpectedBoundaries,
  observed: DatasetObservedCounts,
): void {
  if (
    expected.minimumTimestamp !== observed.minimumTimestamp ||
    expected.maximumTimestamp !== observed.maximumTimestamp ||
    expected.partitionCount !== observed.partitionCount
  ) {
    throw new QueryPlanVerificationError("Dataset timestamp reconciliation failed.");
  }
}

export function assertListReconciliation(
  matchingRows: number,
  resultRows: number,
  rootActualRows: number,
  limit: number,
): void {
  const expectedRows = Math.min(matchingRows, limit + 1);
  if (
    !Number.isSafeInteger(matchingRows) ||
    matchingRows < 0 ||
    resultRows !== expectedRows ||
    rootActualRows !== expectedRows
  ) {
    throw new QueryPlanVerificationError("List-query reconciliation failed.");
  }
}

export function assertAggregationReconciliation(
  matchingRows: number,
  resultRows: number,
  resultCountSum: number,
  rootActualRows: number,
): void {
  if (
    !Number.isSafeInteger(matchingRows) ||
    matchingRows < 0 ||
    !Number.isSafeInteger(resultCountSum) ||
    resultCountSum !== matchingRows ||
    rootActualRows !== resultRows
  ) {
    throw new QueryPlanVerificationError("Aggregation reconciliation failed.");
  }
}

const URI_VALUE_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s]+/iu;

function splitKeyTokens(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

function isUnsafeReportKey(key: string): boolean {
  const tokens = splitKeyTokens(key);
  if (
    tokens.some((token) =>
      ["credential", "credentials", "password", "secret", "secrets"].includes(token),
    ) ||
    tokens.includes("port")
  ) {
    return true;
  }
  const describesLocation = tokens.includes("url") || tokens.includes("uri");
  const describesDatabase = tokens.includes("connection") || tokens.includes("database");
  return (describesLocation && describesDatabase) || tokens.join("") === "connectionstring";
}

function assertSafeReportValue(value: unknown): void {
  if (typeof value === "string") {
    if (URI_VALUE_PATTERN.test(value)) {
      throw new QueryPlanVerificationError("The query-plan report contains a forbidden URI value.");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertSafeReportValue);
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (isUnsafeReportKey(key)) {
      throw new QueryPlanVerificationError("The query-plan report contains a forbidden field.");
    }
    assertSafeReportValue(child);
  }
}

export function serializeQueryPlanReport(report: QueryPlanReport): string {
  assertSafeReportValue(report);
  return `${JSON.stringify(report, null, 2)}\n`;
}

export async function closePreservingPrimaryError(
  close: () => Promise<void>,
  primaryError: Error | undefined,
  cleanupError: Error,
): Promise<Error | undefined> {
  try {
    await close();
  } catch {
    return primaryError ?? cleanupError;
  }
  return primaryError;
}
