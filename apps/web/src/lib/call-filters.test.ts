import { describe, expect, it } from 'vitest';
import {
  filtersToQuery,
  formatDuration,
  PAGE_SIZE,
  parseCallFilters,
  toRecordingQuery,
} from './call-filters';

describe('parseCallFilters', () => {
  it('reads valid filters', () => {
    expect(
      parseCallFilters({
        dataset: 'liva-ai/real-sales',
        duration: 'long',
        source: 'audio',
        page: '3',
      }),
    ).toEqual({ dataset: 'liva-ai/real-sales', duration: 'long', source: 'audio', page: 3 });
  });

  it('ignores invalid values instead of failing', () => {
    expect(
      parseCallFilters({ duration: 'forever', source: 'video', page: '-2', dataset: '' }),
    ).toEqual({ dataset: undefined, duration: undefined, source: undefined, page: 1 });
  });

  it('takes the first of repeated params', () => {
    expect(parseCallFilters({ duration: ['short', 'long'] }).duration).toBe('short');
  });
});

describe('toRecordingQuery', () => {
  it('maps buckets to duration bounds and pages to offsets', () => {
    expect(
      toRecordingQuery({ dataset: undefined, duration: 'medium', source: 'transcript', page: 2 }),
    ).toEqual({
      datasetId: undefined,
      minDurationMs: 300_000,
      maxDurationMs: 900_000,
      hasAudio: false,
      limit: PAGE_SIZE,
      offset: PAGE_SIZE,
    });
  });
});

describe('filtersToQuery', () => {
  it('keeps filters and drops page 1', () => {
    const f = { dataset: 'a/b', duration: 'short' as const, source: undefined, page: 1 };
    expect(filtersToQuery(f)).toBe('?dataset=a%2Fb&duration=short');
    expect(filtersToQuery(f, { page: 2 })).toBe('?dataset=a%2Fb&duration=short&page=2');
    expect(
      filtersToQuery({ dataset: undefined, duration: undefined, source: undefined, page: 1 }),
    ).toBe('');
  });
});

describe('formatDuration', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(754_000)).toBe('12:34');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(0)).toBe('0:00');
  });
});
