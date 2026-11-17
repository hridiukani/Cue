import type { SuggestionTimings } from '@cue/shared';
import { describe, expect, it } from 'vitest';
import { percentile, summarizeEndToEnd } from './latency';

function timingWithE2E(ms: number): SuggestionTimings {
  return {
    utterance_end: 0,
    suggestion_request_sent: 0,
    first_token: 0,
    last_token: 0,
    rendered_in_client: ms,
  };
}

describe('percentile', () => {
  const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it('uses nearest rank', () => {
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(100);
    expect(percentile(xs, 0)).toBe(10);
  });

  it('throws on empty input or bad p', () => {
    expect(() => percentile([], 50)).toThrow();
    expect(() => percentile(xs, 101)).toThrow();
  });
});

describe('summarizeEndToEnd', () => {
  it('returns null for no data', () => {
    expect(summarizeEndToEnd([])).toBeNull();
  });

  it('summarizes end-to-end latency regardless of input order', () => {
    const timings = [900, 300, 500, 700, 1200].map(timingWithE2E);
    expect(summarizeEndToEnd(timings)).toEqual({ count: 5, p50: 700, p95: 1200, max: 1200 });
  });
});
