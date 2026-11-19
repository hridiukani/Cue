import { describe, expect, it } from 'vitest';
import { runDeterministicChecks } from './checks';
import type { JudgeVerdict } from './judge';
import { isUngraded, scoreRun } from './scoring';

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
      ungraded: false,
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

  it('marks a line the judge failed to grade as UNGRADED, not as a failure', () => {
    const r = scoreRun({ checks: clean, verdict: null, error: null, judgeError: 'judge HTTP 429' });
    expect(r).toEqual({
      pass: false,
      ungraded: true,
      score: null,
      reasons: ['ungraded: judge HTTP 429'],
    });
  });

  it('marks a judge failure on a line that also broke a check as ungraded too', () => {
    // A 429 is unrelated to the line, so excluding every judge failure keeps the
    // graded runs a fair sample; keeping only the ones known to fail would not.
    const long = runDeterministicChecks(Array.from({ length: 25 }, () => 'word').join(' '));
    expect(scoreRun({ checks: long, verdict: null, error: null, judgeError: 'x' }).ungraded).toBe(
      true,
    );
  });

  it('counts a model error as a graded failure (errors never improve the pass rate)', () => {
    const r = scoreRun({ checks: null, verdict: null, error: 'model timeout' });
    expect(r).toEqual({ pass: false, ungraded: false, score: null, reasons: ['model timeout'] });
  });

  it('never calls an empty line ungraded: it scores 1 without the judge', () => {
    const r = scoreRun({ checks: runDeterministicChecks(''), verdict: null, error: null });
    expect(r.ungraded).toBe(false);
  });
});

describe('isUngraded (reading saved runs, old files included)', () => {
  it('is a non-empty line with no verdict and no model error', () => {
    expect(isUngraded({ error: null, shown: 'Fair question.', verdict: null })).toBe(true);
    expect(isUngraded({ error: null, shown: 'Fair question.', verdict: verdict() })).toBe(false);
    expect(isUngraded({ error: null, shown: '', verdict: null })).toBe(false);
    expect(isUngraded({ error: 'model: HTTP 500', shown: '', verdict: null })).toBe(false);
  });
});
