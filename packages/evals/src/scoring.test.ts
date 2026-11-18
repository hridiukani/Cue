import { describe, expect, it } from 'vitest';
import { runDeterministicChecks } from './checks';
import type { JudgeVerdict } from './judge';
import { scoreRun } from './scoring';

const clean = runDeterministicChecks('What would it cost to keep doing this by hand?');
const verdict = (over: Partial<JudgeVerdict> = {}): JudgeVerdict => ({
  mustMet: [true, true],
  mustNotViolated: [false, false, false],
  score: 4,
  rationale: 'ok',
  ...over,
});

describe('scoreRun', () => {
  it('passes at score 4 with clean checks and no violations', () => {
    expect(scoreRun({ checks: clean, verdict: verdict(), error: null })).toEqual({
      pass: true,
      score: 4,
      reasons: [],
    });
  });

  it('fails at score 3 (the boundary is 4)', () => {
    const r = scoreRun({ checks: clean, verdict: verdict({ score: 3 }), error: null });
    expect(r).toMatchObject({ pass: false, score: 3, reasons: ['score 3 < 4'] });
  });

  it('fails on any must-not violation, whatever the score', () => {
    const r = scoreRun({
      checks: clean,
      verdict: verdict({ score: 5, mustNotViolated: [false, true, false] }),
      error: null,
    });
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('violates N2');
  });

  it('fails a well-judged line that breaks a deterministic check', () => {
    const long = runDeterministicChecks(Array.from({ length: 25 }, () => 'word').join(' '));
    const r = scoreRun({ checks: long, verdict: verdict({ score: 5 }), error: null });
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toMatch(/^max_words/);
  });

  it('scores an empty line 1 without needing the judge', () => {
    const empty = runDeterministicChecks('');
    expect(scoreRun({ checks: empty, verdict: null, error: null })).toMatchObject({
      pass: false,
      score: 1,
    });
  });

  it('counts an ungraded line as a failure with no score', () => {
    const r = scoreRun({ checks: clean, verdict: null, error: null });
    expect(r).toEqual({ pass: false, score: null, reasons: ['not graded'] });
  });

  it('counts an errored run as a failure (errors never improve the pass rate)', () => {
    const r = scoreRun({ checks: null, verdict: null, error: 'model timeout' });
    expect(r).toEqual({ pass: false, score: null, reasons: ['model timeout'] });
  });
});
