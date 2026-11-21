import { describe, expect, it } from 'vitest';
import {
  countWords,
  REP_CANCEL_MAX_MS,
  REP_CANCEL_MAX_WORDS,
  repSpeechCanCancel,
  repSpeechCancelsSuggestion,
} from './backchannel';

describe('repSpeechCancelsSuggestion', () => {
  it('uses 4 words and 1.5 s as the defaults', () => {
    expect(REP_CANCEL_MAX_WORDS).toBe(4);
    expect(REP_CANCEL_MAX_MS).toBe(1500);
  });

  describe('word threshold (short duration)', () => {
    it('does not cancel at exactly 4 words', () => {
      expect(repSpeechCancelsSuggestion({ text: 'yeah that makes sense', durationMs: 800 })).toBe(
        false,
      );
    });

    it('cancels at 5 words', () => {
      expect(
        repSpeechCancelsSuggestion({ text: 'yeah that makes sense but', durationMs: 800 }),
      ).toBe(true);
    });
  });

  describe('duration threshold (few words)', () => {
    it('does not cancel at exactly 1.5 s', () => {
      expect(repSpeechCancelsSuggestion({ text: 'mmmm hmm', durationMs: 1500 })).toBe(false);
    });

    it('cancels just over 1.5 s', () => {
      expect(repSpeechCancelsSuggestion({ text: 'mmmm hmm', durationMs: 1501 })).toBe(true);
    });
  });

  it('ignores typical backchannels', () => {
    for (const text of ['mm-hmm', 'right', 'yeah', 'okay got it', 'sure, totally']) {
      expect(repSpeechCancelsSuggestion({ text, durationMs: 400 })).toBe(false);
    }
  });

  it('accepts custom thresholds', () => {
    const strict = { maxWords: 1, maxMs: 200 };
    expect(repSpeechCancelsSuggestion({ text: 'mm hmm', durationMs: 100 }, strict)).toBe(true);
    expect(repSpeechCancelsSuggestion({ text: 'mm', durationMs: 201 }, strict)).toBe(true);
    expect(repSpeechCancelsSuggestion({ text: 'mm', durationMs: 200 }, strict)).toBe(false);
  });

  it('counts words on whitespace and ignores empty text', () => {
    expect(countWords('  well,   okay   then ')).toBe(3);
    expect(countWords('')).toBe(0);
  });
});

describe('repSpeechCanCancel', () => {
  it('lets rep speech cancel only on recordings with real timing', () => {
    expect(repSpeechCanCancel('real')).toBe(true);
    // gwenshap/saas: start times and lengths are invented at import, so the
    // rep "starting to talk" isn't evidence the rep took the turn.
    expect(repSpeechCanCancel('estimated')).toBe(false);
  });
});
