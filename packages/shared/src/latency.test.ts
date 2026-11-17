import { describe, expect, it } from 'vitest';
import { SuggestionTimingsSchema, endToEndLatencyMs } from './latency';

const valid = {
  utterance_end: 1_000,
  suggestion_request_sent: 1_020,
  first_token: 1_300,
  last_token: 1_550,
  rendered_in_client: 1_600,
};

describe('SuggestionTimingsSchema', () => {
  it('accepts monotonically ordered timestamps', () => {
    expect(SuggestionTimingsSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a missing timestamp', () => {
    const { first_token: _omit, ...rest } = valid;
    expect(SuggestionTimingsSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(SuggestionTimingsSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });

  it('rejects out-of-order timestamps and points at the offending key', () => {
    const result = SuggestionTimingsSchema.safeParse({ ...valid, first_token: 1_010 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['first_token']);
  });
});

describe('endToEndLatencyMs', () => {
  it('measures utterance_end → rendered_in_client', () => {
    expect(endToEndLatencyMs(SuggestionTimingsSchema.parse(valid))).toBe(600);
  });
});
