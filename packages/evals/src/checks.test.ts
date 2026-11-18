import { describe, expect, it } from 'vitest';
import { containsPhrase, runDeterministicChecks } from './checks';

const failing = (raw: string, banned: string[] = []) =>
  runDeterministicChecks(raw, banned)
    .checks.filter((c) => !c.pass)
    .map((c) => c.id);

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${String(i)}`).join(' ');

describe('runDeterministicChecks', () => {
  it('passes a clean one-line suggestion', () => {
    const r = runDeterministicChecks('What would it cost you to keep doing this by hand?');
    expect(r.pass).toBe(true);
    expect(r.shown).toBe('What would it cost you to keep doing this by hand?');
    expect(r.words).toBe(11);
  });

  it('fails an empty or whitespace-only output', () => {
    expect(failing('')).toEqual(['non_empty']);
    expect(failing('  \n ')).toEqual(['non_empty']);
    expect(failing('"  "')).toEqual(['non_empty']);
  });

  describe('length: exactly 20 words passes, 21 fails', () => {
    it('20 words', () => {
      expect(failing(words(20))).toEqual([]);
    });
    it('21 words, which production would cut', () => {
      const r = runDeterministicChecks(words(21));
      expect(r.checks.find((c) => c.id === 'max_words')).toMatchObject({
        pass: false,
        detail: '21 words; production cuts it at 20',
      });
      expect(r.words).toBe(21);
      expect(r.shown.split(' ')).toHaveLength(20); // what the rep would have seen
    });
    it('counts the line without its preamble', () => {
      // 20 words plus "Rep:" is still 20 words of line; the preamble fails separately.
      expect(failing(`Rep: ${words(20)}`)).toEqual(['no_preamble']);
    });
  });

  it('fails extra lines (the rep only sees the first)', () => {
    expect(failing('Ask about budget.\nThis works because it reframes value.')).toEqual([
      'one_line',
    ]);
  });

  it.each([
    'Rep: Ask about budget.',
    "Sure! Here's a line: Ask about budget.",
    'Suggestion - Ask about budget.',
  ])('fails the preamble in %j', (raw) => {
    expect(failing(raw)).toEqual(['no_preamble']);
  });

  it('does not treat a natural opener as a preamble', () => {
    expect(failing('Okay, what does your team use today?')).toEqual([]);
  });

  it.each(['Hi [Name], can we talk budget?', 'Would {company} pilot it?', 'Does <product> fit?'])(
    'fails the unfilled placeholder in %j',
    (raw) => {
      expect(failing(raw)).toEqual(['no_placeholders']);
    },
  );

  it('fails global and case banned phrases, case-insensitively, on word boundaries', () => {
    expect(failing('As an AI, I suggest asking about budget.')).toEqual(['no_banned_phrases']);
    expect(failing('Totally get it, great question!', ['great question'])).toEqual([
      'no_banned_phrases',
    ]);
    // "price" banned must not catch "priceless".
    expect(failing('That insight is priceless, what else?', ['price'])).toEqual([]);
    expect(failing('What price did they quote?', ['price'])).toEqual(['no_banned_phrases']);
  });

  it('reports every failure at once', () => {
    expect(failing(`Rep: [Name] ${words(25)}\nmore`)).toEqual([
      'max_words',
      'one_line',
      'no_preamble',
      'no_placeholders',
    ]);
  });
});

describe('containsPhrase', () => {
  it('matches across whitespace and punctuation-ended phrases', () => {
    expect(containsPhrase('great   question there', 'great question')).toBe(true);
    expect(containsPhrase('Sales rep: hello', 'sales rep:')).toBe(true);
    expect(containsPhrase('cost (per seat)', '(per seat)')).toBe(true);
    expect(containsPhrase('nothing here', 'great question')).toBe(false);
  });
});
