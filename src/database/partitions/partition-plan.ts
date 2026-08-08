const MILLISECONDS_PER_DAY = 86_400_000;
const PARTITION_NAME_PATTERN = /^logs_[0-9]{8}$/;
const UTC_BOUNDARY_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00\.000Z$/;

export interface DailyPartition {
  readonly name: string;
  readonly start: string;
  readonly end: string;
}

export class InvalidPartitionPlanError extends Error {
  public constructor() {
    super("The UTC partition plan is invalid.");
    this.name = "InvalidPartitionPlanError";
  }
}

function assertUtcBoundary(value: string): void {
  if (!UTC_BOUNDARY_PATTERN.test(value)) {
    throw new InvalidPartitionPlanError();
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new InvalidPartitionPlanError();
  }
}

export function assertDailyPartition(partition: DailyPartition): void {
  if (!PARTITION_NAME_PATTERN.test(partition.name)) {
    throw new InvalidPartitionPlanError();
  }
  assertUtcBoundary(partition.start);
  assertUtcBoundary(partition.end);

  const startTimestamp = Date.parse(partition.start);
  const endTimestamp = Date.parse(partition.end);
  const expectedName = `logs_${partition.start.slice(0, 10).replaceAll("-", "")}`;
  if (partition.name !== expectedName || endTimestamp - startTimestamp !== MILLISECONDS_PER_DAY) {
    throw new InvalidPartitionPlanError();
  }
}

function partitionForTimestamp(timestamp: number): DailyPartition {
  const startDate = new Date(timestamp);
  const endDate = new Date(timestamp + MILLISECONDS_PER_DAY);
  const start = startDate.toISOString();
  const end = endDate.toISOString();
  const name = `logs_${start.slice(0, 10).replaceAll("-", "")}`;
  const partition = { name, start, end };
  assertDailyPartition(partition);
  return partition;
}

export function buildPartitionPlan(
  currentTime: Date,
  retentionDays: number,
): readonly DailyPartition[] {
  const currentTimestamp = currentTime.getTime();
  if (
    !Number.isFinite(currentTimestamp) ||
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 3_650
  ) {
    throw new InvalidPartitionPlanError();
  }

  const currentUtcDay = Math.floor(currentTimestamp / MILLISECONDS_PER_DAY) * MILLISECONDS_PER_DAY;
  const firstDay = currentUtcDay - retentionDays * MILLISECONDS_PER_DAY;
  const partitions: DailyPartition[] = [];
  for (let offset = 0; offset <= retentionDays + 2; offset += 1) {
    partitions.push(partitionForTimestamp(firstDay + offset * MILLISECONDS_PER_DAY));
  }
  return partitions;
}
