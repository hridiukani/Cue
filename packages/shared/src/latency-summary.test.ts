import { describe, expect, it } from 'vitest';
import {
  nearestRank,
  summarizeLatency,
  summarizeLatencyByPromptVersion,
  type TimingRow,
} from './latency-summary';

const T0 = Date.UTC(2026, 10, 20, 12);
const at = (ms: number) => new Date(T0 + ms);

/** A complete, painted suggestion with these stage durations (ms). */
function row(pipeline: number, firstToken: number, stream: number, paint: number): TimingRow {
  let t = 0;
  const utteranceEndAt = at(t);
  const requestSentAt = at((t += pipeline));
  const firstTokenAt = at((t += firstToken));
  const lastTokenAt = at((t += stream));
  const clientRenderedAt = at(t + paint);
  return {
    status: 'complete',
    failureReason: null,
    promptVersion: 'suggest-v2',
    utteranceEndAt,
    requestSentAt,
    firstTokenAt,
    lastTokenAt,
    clientRenderedAt,
  };
}

describe('nearestRank', () => {
  it('picks the nearest-rank value', () => {
    const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(nearestRank(v, 50)).toBe(50);
    expect(nearestRank(v, 95)).toBe(100);
    expect(nearestRank([7], 95)).toBe(7);
  });

  it('refuses an empty list', () => {
    expect(() => nearestRank([], 50)).toThrow(/empty/);
  });
});

describe('summarizeLatency', () => {
  it('splits every complete, painted suggestion into stages', () => {
    const s = summarizeLatency([row(20, 400, 100, 30), row(10, 300, 80, 20), row(30, 500, 90, 40)]);
    expect(s.samples).toBe(3);
    expect(s.stages.pipeline).toEqual({ count: 3, p50: 20, p95: 30, max: 30 });
    expect(s.stages.firstToken).toEqual({ count: 3, p50: 400, p95: 500, max: 500 });
    expect(s.stages.toFirstToken).toEqual({ count: 3, p50: 420, p95: 530, max: 530 });
    expect(s.stages.endToEnd).toEqual({ count: 3, p50: 550, p95: 660, max: 660 });
  });

  it('counts failures by reason and incomplete rows, but never uses them as samples', () => {
    const failed = (reason: string): TimingRow => ({
      ...row(10, 2000, 0, 0),
      status: 'failed',
      failureReason: reason,
    });
    const neverPainted: TimingRow = { ...row(10, 300, 50, 0), clientRenderedAt: null };
    const streaming: TimingRow = { ...row(10, 300, 0, 0), status: 'streaming', lastTokenAt: null };
    const s = summarizeLatency([
      row(10, 300, 50, 20),
      failed('first_token_timeout'),
      failed('cancelled_newer'),
      failed('first_token_timeout'),
      neverPainted,
      streaming,
    ]);
    expect(s.suggestions).toBe(6);
    expect(s.samples).toBe(1);
    expect(s.failed).toEqual({ first_token_timeout: 2, cancelled_newer: 1 });
    expect(s.incomplete).toBe(2);
  });

  it('counts out-of-order timestamps instead of letting them skew the percentiles', () => {
    const bad: TimingRow = { ...row(10, 300, 50, 20), clientRenderedAt: at(-5) };
    const s = summarizeLatency([bad, row(10, 300, 50, 20)]);
    expect(s.outOfOrder).toBe(1);
    expect(s.samples).toBe(1);
  });

  it('leaves skipped rows out of the samples and the request count, and counts them by reason', () => {
    const skipped: TimingRow = {
      status: 'skipped',
      failureReason: null,
      skipReason: 'prospect_backchannel',
      promptVersion: 'suggest-v2',
      utteranceEndAt: at(0),
      requestSentAt: null,
      firstTokenAt: null,
      lastTokenAt: null,
      clientRenderedAt: null,
    };
    const s = summarizeLatency([skipped, skipped, row(10, 300, 50, 20)]);
    expect(s.skipped).toEqual({ prospect_backchannel: 2 });
    expect(s.suggestions).toBe(1);
    expect(s.samples).toBe(1);
    expect(s.incomplete).toBe(0);
    expect(s.stages.firstToken?.count).toBe(1);
  });

  it('has no stats without samples', () => {
    const s = summarizeLatency([]);
    expect(s.samples).toBe(0);
    expect(s.stages.endToEnd).toBeNull();
  });
});

describe('summarizeLatencyByPromptVersion', () => {
  it('summarizes each prompt version separately, most samples first', () => {
    const v1 = { ...row(10, 300, 50, 20), promptVersion: 'suggest-v1' };
    const groups = summarizeLatencyByPromptVersion([
      v1,
      row(10, 400, 50, 20),
      row(10, 420, 50, 20),
    ]);
    expect(groups.map((g) => [g.promptVersion, g.summary.samples])).toEqual([
      ['suggest-v2', 2],
      ['suggest-v1', 1],
    ]);
    expect(groups[1]?.summary.stages.firstToken?.p50).toBe(300);
  });
});
