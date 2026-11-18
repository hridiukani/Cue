import { describe, expect, it } from 'vitest';
import { CaseFileError, parseCases, rubricHash } from './cases';

const base = {
  id: 'price-objection-01',
  status: 'DRAFT',
  category: 'price_objection',
  smoke: true,
  source: {
    dataset: 'gwenshap/sales-transcripts',
    license: 'apache-2.0',
    callId: 'transcript-07',
    utterances: [3, 4],
  },
  playbook: 'none',
  window: ['Rep: The plan is 400 a month.', 'Prospect: That is more than we budgeted.'],
  rubric: { must: ['Acknowledges the budget concern'], mustNot: [], bannedPhrases: [] },
  notes: '',
};

const line = (over: Record<string, unknown> = {}) => JSON.stringify({ ...base, ...over });

function problems(text: string): string[] {
  try {
    parseCases(text);
  } catch (err) {
    if (err instanceof CaseFileError) return err.problems;
    throw err;
  }
  return [];
}

describe('parseCases', () => {
  it('parses a case and turns "Rep:"/"Prospect:" lines into utterances', () => {
    const [c] = parseCases(line());
    expect(c?.window).toEqual([
      { speaker: 'rep', text: 'The plan is 400 a month.' },
      { speaker: 'prospect', text: 'That is more than we budgeted.' },
    ]);
  });

  it('skips blank lines and // comments', () => {
    expect(parseCases(`// header\n\n${line()}\n  \n`)).toHaveLength(1);
  });

  it('reports every problem with its line number', () => {
    const text = [
      line(),
      '{not json',
      line({ id: 'price-objection-01' }), // duplicate
      line({ id: 'x2', category: 'nope' }),
    ].join('\n');
    expect(problems(text)).toEqual([
      'line 2: not valid JSON',
      'line 3: duplicate id "price-objection-01" (first on line 1)',
      'line 4 id: lowercase letters, digits and dashes',
      expect.stringMatching(/^line 4 category:/),
    ]);
  });

  it('requires the window to end with the prospect', () => {
    expect(problems(line({ window: ['Prospect: hi', 'Rep: hello'] }))).toEqual([
      'line 1 window: the last line must be the prospect',
    ]);
  });

  it('requires the window to match the utterance range', () => {
    expect(problems(line({ source: { ...base.source, utterances: [1, 4] } }))).toEqual([
      'line 1 window: window has 2 lines but source.utterances spans 4',
    ]);
  });

  it('rejects lines without a speaker label', () => {
    expect(problems(line({ window: ['The plan is 400.', 'Prospect: ok'] }))[0]).toMatch(
      /must start with "Rep: " or "Prospect: "/,
    );
  });

  it('refuses to inline a window from a dataset without a license', () => {
    const src = { ...base.source, dataset: 'liva-ai/real-sales', license: 'unspecified' };
    expect(problems(line({ source: src, smoke: false }))).toEqual([
      'line 1 window: datasets without a license must not be copied in: set window to null',
    ]);
    expect(parseCases(line({ source: src, smoke: false, window: null }))).toHaveLength(1);
  });

  it('requires smoke cases to be self-contained (CI has no database)', () => {
    expect(problems(line({ window: null }))).toEqual([
      'line 1 smoke: smoke cases need an inline window (CI has no database)',
    ]);
  });

  it('rejects unknown fields, so typos in hand edits are caught', () => {
    expect(problems(line({ rubrc: {} }))[0]).toMatch(/^line 1: Unrecognized key/);
  });
});

describe('rubricHash', () => {
  it('changes when the rubric changes, not when notes or status do', () => {
    const [a] = parseCases(line());
    const [b] = parseCases(line({ notes: 'reviewed', status: 'REVIEWED' }));
    const [c] = parseCases(line({ rubric: { must: ['Something else'] } }));
    if (!a || !b || !c) throw new Error('parse failed');
    expect(rubricHash(a)).toBe(rubricHash(b));
    expect(rubricHash(a)).not.toBe(rubricHash(c));
  });
});
