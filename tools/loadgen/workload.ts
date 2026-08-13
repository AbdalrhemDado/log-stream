import {
  LOAD_GENERATOR_VERSION,
  type SyntheticLog,
  type WorkloadBatch,
  type WorkloadPhase,
} from "./types.js";

const SERVICES = [
  "checkout",
  "auth",
  "catalog",
  "payments",
  "orders",
  "inventory",
  "shipping",
  "notifications",
] as const;
const REGIONS = ["eu-west", "us-east", "ap-south", "eu-central"] as const;
const MESSAGES = [
  "request completed",
  "cache lookup completed",
  "downstream response received",
  "inventory reservation updated",
  "payment workflow advanced",
  "notification delivery scheduled",
] as const;
const TWENTY_EIGHT_DAYS_MS = 28 * 24 * 60 * 60 * 1_000;

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function mix(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function rowRandom(
  seed: number,
  referenceTimeMs: number,
  phase: WorkloadPhase,
  ordinal: number,
): number {
  const identity = `${LOAD_GENERATOR_VERSION}|${String(seed)}|${String(referenceTimeMs)}|${phase}|${String(ordinal)}`;
  return mix(hashString(identity));
}

function weightedLevel(random: number): SyntheticLog["level"] {
  const percentile = random % 100;
  if (percentile < 10) return "debug";
  if (percentile < 75) return "info";
  if (percentile < 93) return "warn";
  return "error";
}

export function createSequence(phase: WorkloadPhase, ordinal: number): string {
  return `${phase === "warmup" ? "w" : "m"}-${String(ordinal).padStart(12, "0")}`;
}

export function generateLog(
  seed: number,
  referenceTimeMs: number,
  runId: string,
  phase: WorkloadPhase,
  ordinal: number,
): SyntheticLog {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new Error("Workload ordinal must be a non-negative safe integer.");
  }
  const random = rowRandom(seed, referenceTimeMs, phase, ordinal);
  const service = SERVICES[random % SERVICES.length] ?? "checkout";
  const region = REGIONS[(random >>> 3) % REGIONS.length] ?? "eu-west";
  const message = MESSAGES[(random >>> 7) % MESSAGES.length] ?? "request completed";
  const offsetMs = random % TWENTY_EIGHT_DAYS_MS;
  const sequence = createSequence(phase, ordinal);

  return {
    timestamp: new Date(referenceTimeMs - offsetMs).toISOString(),
    level: weightedLevel(random),
    service,
    message: `${message} for ${service}`,
    attributes: {
      loadgen_run_id: runId,
      loadgen_phase: phase,
      loadgen_sequence: sequence,
      request_id: `synthetic-${seed.toString(16)}-${sequence}`,
      region,
      attempt: (random >>> 11) % 5,
      cached: (random & 1) === 0,
    },
  };
}

export function createWorkloadBatch(input: {
  readonly seed: number;
  readonly referenceTimeMs: number;
  readonly runId: string;
  readonly phase: WorkloadPhase;
  readonly totalRows: number;
  readonly batchSize: number;
  readonly batchIndex: number;
}): WorkloadBatch {
  const firstOrdinal = input.batchIndex * input.batchSize;
  const count = Math.min(input.batchSize, input.totalRows - firstOrdinal);
  if (count <= 0) {
    throw new Error("Workload batch index is outside the configured row total.");
  }
  return {
    phase: input.phase,
    batchIndex: input.batchIndex,
    firstOrdinal,
    logs: Array.from({ length: count }, (_, offset) =>
      generateLog(
        input.seed,
        input.referenceTimeMs,
        input.runId,
        input.phase,
        firstOrdinal + offset,
      ),
    ),
  };
}

export const WORKLOAD_DISTRIBUTION = {
  timestampWindowDays: 28,
  services: SERVICES,
  levels: { debugPercent: 10, infoPercent: 65, warnPercent: 18, errorPercent: 7 },
  messages: MESSAGES,
  attributes: [
    "loadgen_run_id:string",
    "loadgen_phase:string",
    "loadgen_sequence:string",
    "request_id:string",
    "region:string",
    "attempt:number",
    "cached:boolean",
  ],
} as const;
