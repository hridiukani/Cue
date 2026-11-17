import { describe, expect, it } from 'vitest';
import { toSuggestionTimings } from './timings';

const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms);

const complete = {
  utteranceEndAt: at(0),
  requestSentAt: at(15),
  firstTokenAt: at(280),
  lastTokenAt: at(520),
  clientRenderedAt: at(560),
};

describe('toSuggestionTimings', () => {
  it('maps DB columns to the shared timing keys as epoch ms', () => {
    const base = Date.UTC(2026, 0, 1);
    expect(toSuggestionTimings(complete)).toEqual({
      utterance_end: base,
      suggestion_request_sent: base + 15,
      first_token: base + 280,
      last_token: base + 520,
      rendered_in_client: base + 560,
    });
  });

  it('returns null while any timestamp is missing', () => {
    expect(toSuggestionTimings({ ...complete, clientRenderedAt: null })).toBeNull();
    expect(toSuggestionTimings({ ...complete, firstTokenAt: null })).toBeNull();
  });

  it('throws on out-of-order timestamps', () => {
    expect(() => toSuggestionTimings({ ...complete, firstTokenAt: at(10) })).toThrow(/first_token/);
  });
});
