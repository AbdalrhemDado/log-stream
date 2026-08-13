import type { PercentileSummary } from "./types.js";

const MAX_REPORTED_RAW_SAMPLES = 20_000;

export function nearestRank(samples: readonly number[], percentile: 50 | 95 | 99): number {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error("Nearest-rank samples must be finite, non-negative, and non-empty.");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  const value = sorted[index];
  if (value === undefined) throw new Error("Nearest-rank sample lookup failed.");
  return value;
}

export function summarizeSamples(
  samples: readonly number[],
  unavailableReason = "No terminal samples were recorded.",
): PercentileSummary {
  if (samples.length === 0) {
    return {
      unit: "milliseconds",
      method: "non-interpolated nearest-rank",
      sampleCount: 0,
      p50: null,
      p95: null,
      p99: null,
      unavailableReason,
      rawSamples: [],
      rawSamplesTruncated: false,
    };
  }
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new Error("Latency samples must be finite and non-negative.");
  }
  return {
    unit: "milliseconds",
    method: "non-interpolated nearest-rank",
    sampleCount: samples.length,
    p50: nearestRank(samples, 50),
    p95: nearestRank(samples, 95),
    p99: nearestRank(samples, 99),
    unavailableReason: null,
    rawSamples: samples.slice(0, MAX_REPORTED_RAW_SAMPLES),
    rawSamplesTruncated: samples.length > MAX_REPORTED_RAW_SAMPLES,
  };
}

export function ratePerSecond(count: number, durationMs: number): number | null {
  if (
    count < 0 ||
    !Number.isSafeInteger(count) ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    return null;
  }
  return (count * 1_000) / durationMs;
}
