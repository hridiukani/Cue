import { describe, expect, it } from 'vitest';
import { compareRuns } from './compare';
import { fakeCase, fakeRunFile } from './fixtures.test-helpers';
import { formatCompare } from './report';

const cmp = (a: ReturnType<typeof fakeRunFile>, b: ReturnType<typeof fakeRunFile>) =>
  compareRuns({ file: 'a.json', run: a }, { file: 'b.json', run: b });

const statusOf = (r: ReturnType<typeof cmp>, id: string) =>
  r.cases.find((c) => c.id === id)?.status;

describe('compareRuns', () => {
  it('flags a case whose pass rate drops by a full run out of 3 (≥ 0.25) as a regression', () => {
    const r = cmp(fakeRunFile([fakeCase('a', 3, 3)]), fakeRunFile([fakeCase('a', 2, 3)]));
    expect(statusOf(r, 'a')).toBe('regressed');
    expect(r.regressions).toBe(1);
    expect(r.cases[0]?.passRateDelta).toBeCloseTo(-1 / 3);
  });

  it('does not flag a pass-rate drop below 0.25 (1 of 5 runs = 0.2)', () => {
    const r = cmp(
      fakeRunFile([fakeCase('a', 5, 5, { score: 4 })]),
      fakeRunFile([fakeCase('a', 4, 5, { score: 4 })]),
    );
    // Score also moves: (4×4 + 2)/5 = 3.6, a drop of 0.4 < 0.5.
    expect(statusOf(r, 'a')).toBe('unchanged');
  });

  it('flags a mean-score drop of 0.5 even when the pass rate holds', () => {
    const r = cmp(
      fakeRunFile([fakeCase('a', 3, 3, { score: 5 })]),
      fakeRunFile([fakeCase('a', 3, 3, { score: 4.5 })]),
    );
    expect(statusOf(r, 'a')).toBe('regressed');
    const s = cmp(
      fakeRunFile([fakeCase('a', 3, 3, { score: 5 })]),
      fakeRunFile([fakeCase('a', 3, 3, { score: 4.6 })]),
    );
    expect(statusOf(s, 'a')).toBe('unchanged');
  });

  it('reports improvements as the mirror image', () => {
    const r = cmp(fakeRunFile([fakeCase('a', 1, 3)]), fakeRunFile([fakeCase('a', 3, 3)]));
    expect(statusOf(r, 'a')).toBe('improved');
    expect(r.improvements).toBe(1);
  });

  it('never calls a case with a changed rubric a regression', () => {
    const r = cmp(
      fakeRunFile([fakeCase('a', 3, 3, { rubricHash: 'old' })]),
      fakeRunFile([fakeCase('a', 0, 3, { rubricHash: 'new' })]),
    );
    expect(statusOf(r, 'a')).toBe('rubric_changed');
    expect(r.regressions).toBe(0);
  });

  it('does not compare a case where either run had a model or judge error', () => {
    const ungraded = fakeCase('a', 1, 3);
    const first = ungraded.runs[1];
    if (first) Object.assign(first, { judgeError: 'judge HTTP 429', verdict: null, score: null });
    const r = cmp(fakeRunFile([fakeCase('a', 3, 3)]), fakeRunFile([ungraded]));
    expect(statusOf(r, 'a')).toBe('errored');
    expect(r.regressions).toBe(0);
  });

  it('flags identical settings, where every difference is noise', () => {
    const same = cmp(fakeRunFile([fakeCase('a', 3, 3)]), fakeRunFile([fakeCase('a', 2, 3)]));
    expect(same.sameSettings).toBe(true);
    expect(formatCompare(same)).toMatch(
      /run-to-run noise\. With N=3, one flipped run moves a case by 33 points/,
    );
    const changed = cmp(
      fakeRunFile([fakeCase('a', 3, 3)]),
      fakeRunFile([fakeCase('a', 3, 3)], { promptVersion: 'suggest-v2' }),
    );
    expect(changed.sameSettings).toBe(false);
    expect(formatCompare(changed)).not.toMatch(/run-to-run noise/);
  });

  it('lists cases present in only one run', () => {
    const r = cmp(
      fakeRunFile([fakeCase('a', 3, 3), fakeCase('b', 3, 3)]),
      fakeRunFile([fakeCase('a', 3, 3), fakeCase('c', 3, 3)]),
    );
    expect(statusOf(r, 'b')).toBe('only_in_a');
    expect(statusOf(r, 'c')).toBe('only_in_b');
  });

  it('says which settings differ, so a judge change is not read as a prompt change', () => {
    const r = cmp(
      fakeRunFile([fakeCase('a', 3, 3)]),
      fakeRunFile([fakeCase('a', 3, 3)], {
        promptVersion: 'suggest-v2',
        judgeVersion: 'judge-v2',
        casesFile: { path: 'x', sha256: 'bbb' },
      }),
    );
    expect(r.settingsChanged).toEqual([
      'prompt version: suggest-v1 → suggest-v2',
      'judge version: judge-v1 → judge-v2',
      'cases file changed',
    ]);
  });

  it('flags an overall pass-rate drop of 5 points or more', () => {
    const before = fakeRunFile(
      Array.from({ length: 10 }, (_, i) => fakeCase(`c${String(i)}`, 2, 2)),
    );
    const after = fakeRunFile(
      Array.from({ length: 10 }, (_, i) => fakeCase(`c${String(i)}`, i === 0 ? 1 : 2, 2)),
    );
    const r = cmp(before, after);
    expect(r.metrics.passRate.delta).toBeCloseTo(-0.05);
    expect(r.overallRegressed).toBe(true);
  });

  it('diffs latency and cost', () => {
    const r = cmp(fakeRunFile([fakeCase('a', 3, 3)]), fakeRunFile([fakeCase('a', 3, 3)]));
    expect(r.metrics.firstTokenP50).toEqual({ a: 300, b: 300, delta: 0 });
    expect(r.metrics.costPer1000Usd.delta).toBeCloseTo(0);
  });
});

describe('formatCompare', () => {
  it('highlights regressions first and ends with the verdict (plain text)', () => {
    const r = cmp(
      fakeRunFile([fakeCase('good', 1, 3), fakeCase('bad', 3, 3)]),
      fakeRunFile([fakeCase('good', 3, 3), fakeCase('bad', 0, 3)]),
    );
    const text = formatCompare(r);
    expect(text.indexOf('REGRESSED')).toBeLessThan(text.indexOf('improved'));
    expect(text).toMatch(/bad\s+price_objection\s+100\.0% → 0\.0%/);
    expect(text.trim().split('\n').at(-1)).toBe(
      '1 regression(s), 1 improvement(s) · overall pass rate regressed',
    );
    expect(text.includes('\u001b[')).toBe(false); // no colour codes unless asked
  });
});
