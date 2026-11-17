import { endToEndLatencyMs, type SuggestionTimings } from '@cue/shared';

export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

/** Nearest-rank percentile. `sorted` must be ascending and non-empty. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error('percentile of empty list');
  if (p < 0 || p > 100) throw new Error(`percentile out of range: ${p}`);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  const value = sorted[rank - 1];
  if (value === undefined) throw new Error('unreachable: rank out of bounds');
  return value;
}

/** End-to-end (utterance_end → rendered_in_client) latency summary. */
export function summarizeEndToEnd(timings: readonly SuggestionTimings[]): LatencySummary | null {
  if (timings.length === 0) return null;
  const sorted = timings.map(endToEndLatencyMs).sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: percentile(sorted, 100),
  };
}
