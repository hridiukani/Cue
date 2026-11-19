import { describe, expect, it } from 'vitest';
import { costUsd, priceOf } from './pricing';
import {
  type CaseRecord,
  type RunRecord,
  runProblems,
  summarizeCase,
  summarizeRun,
  tooManyUngraded,
  UNGRADED_MAX_SHARE,
} from './summary';

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    attempt: 1,
    raw: 'line',
    shown: 'line',
    words: 1,
    checks: [],
    verdict: { mustMet: [true], mustNotViolated: [false, false, false], score: 4, rationale: 'ok' },
    judgeError: null,
    error: null,
    pass: true,
    score: 4,
    reasons: [],
    firstTokenMs: 300,
    overDeadline: false,
    usage: { promptTokens: 1000, completionTokens: 100, reasoningTokens: 40 },
    judgeUsage: { promptTokens: 2000, completionTokens: 200, reasoningTokens: 100 },
    ...over,
  };
}

function kase(id: string, runs: RunRecord[], category = 'price_objection'): CaseRecord {
  return {
    id,
    category,
    dataset: 'gwenshap/sales-transcripts',
    license: 'apache-2.0',
    rubricHash: 'h',
    playbook: 'none',
    status: 'DRAFT',
    runs,
  };
}

/** The judge returned 429: a line exists, but no verdict. */
const ungradedRun = () =>
  run({ verdict: null, judgeError: 'judge HTTP 429', pass: false, score: null });

const MODELS = { model: 'openai/gpt-oss-20b', judgeModel: 'openai/gpt-oss-120b' };

describe('summarizeCase', () => {
  it('computes pass rate, mean score and population std dev over N runs', () => {
    const s = summarizeCase(
      kase('a', [run({ score: 5 }), run({ score: 3, pass: false }), run({ score: 4 })]),
    );
    expect(s).toMatchObject({ runs: 3, passes: 2, meanScore: 4, flaky: true, errors: 0 });
    expect(s.passRate).toBeCloseTo(2 / 3);
    expect(s.scoreStdDev).toBeCloseTo(Math.sqrt(2 / 3)); // scores 5,3,4 around a mean of 4
  });

  it('is not flaky when every run agrees, and has zero spread', () => {
    expect(summarizeCase(kase('a', [run(), run()]))).toMatchObject({
      flaky: false,
      scoreStdDev: 0,
    });
    expect(summarizeCase(kase('b', [run({ pass: false }), run({ pass: false })])).flaky).toBe(
      false,
    );
  });

  it('counts a model error as a graded failure (the rep got nothing)', () => {
    const s = summarizeCase(
      kase('a', [run({ score: null, pass: false, error: 'x', verdict: null, shown: '' }), run()]),
    );
    expect(s).toMatchObject({
      runs: 2,
      graded: 2,
      ungraded: 0,
      passes: 1,
      passRate: 0.5,
      meanScore: 4,
      errors: 1,
      modelErrors: 1,
    });
  });

  it('leaves an ungraded run out of the pass rate and mean, but counts it as an error', () => {
    const s = summarizeCase(
      kase('a', [ungradedRun(), run({ score: 5 }), run({ score: 3, pass: false })]),
    );
    expect(s).toMatchObject({
      runs: 3,
      graded: 2,
      ungraded: 1,
      passes: 1,
      passRate: 0.5,
      meanScore: 4,
      errors: 1,
      modelErrors: 0,
      flaky: true,
    });
  });

  it('has no pass rate when nothing was graded (not 0%)', () => {
    const s = summarizeCase(kase('a', [ungradedRun(), ungradedRun()]));
    expect(s).toMatchObject({ graded: 0, passRate: null, meanScore: null, flaky: false });
  });
});

describe('summarizeRun', () => {
  const cases = [
    kase('a', [run({ firstTokenMs: 100 }), run({ firstTokenMs: 200 })]),
    kase(
      'b',
      [
        run({ pass: false, score: 2, firstTokenMs: 1600, overDeadline: true }),
        run({ firstTokenMs: 400 }),
      ],
      'buying_signal',
    ),
  ];

  it('reports pass rate, mean score, variance, latency percentiles and deadline misses', () => {
    const s = summarizeRun(cases, MODELS);
    expect(s).toMatchObject({
      cases: 2,
      runs: 4,
      passes: 3,
      passRate: 0.75,
      meanScore: 3.5,
      flakyCases: 1,
      errors: 0,
      overDeadline: 1,
      firstTokenMs: { count: 4, p50: 200, p95: 1600 },
    });
    expect(s.meanCaseScoreStdDev).toBeCloseTo((0 + 1) / 2);
    expect(s.byCategory).toEqual({
      price_objection: { runs: 2, graded: 2, ungraded: 0, passes: 2, passRate: 1 },
      buying_signal: { runs: 2, graded: 2, ungraded: 0, passes: 1, passRate: 0.5 },
    });
  });

  it('prices 1,000 suggestions from real token counts (reasoning billed as output)', () => {
    // 1000 in × $0.075/M + 100 out × $0.30/M = $0.000105 per suggestion.
    const s = summarizeRun(cases, MODELS);
    expect(s.costPer1000Usd).toBeCloseTo(0.105, 6);
    expect(s.costedRuns).toBe(4);
    // Judge: 4 × (2000 × 0.15 + 200 × 0.60) / 1M = $0.00168.
    expect(s.judgeCostUsd).toBeCloseTo(0.00168, 8);
  });

  it('says the cost is unknown rather than guessing for an unpriced model', () => {
    const s = summarizeRun(cases, { model: 'some/new-model', judgeModel: 'other/new-judge' });
    expect(s.costPer1000Usd).toBeNull();
    expect(s.costedRuns).toBe(0);
    expect(s.judgeCostUsd).toBeNull();
  });

  it('averages cost over the runs that reported usage only, and says how many', () => {
    const s = summarizeRun([kase('a', [run(), run({ usage: null })])], MODELS);
    expect(s.costedRuns).toBe(1);
    expect(s.costPer1000Usd).toBeCloseTo(0.105, 6);
  });

  it('handles a run with no successful generations', () => {
    const s = summarizeRun(
      [
        kase('a', [
          run({ pass: false, score: null, firstTokenMs: null, error: 'down', usage: null }),
        ]),
      ],
      MODELS,
    );
    expect(s).toMatchObject({ passRate: 0, meanScore: null, firstTokenMs: null, errors: 1 });
  });

  it('excludes ungraded runs from the pass rate, reports them, and flags more than 5%', () => {
    // The 2026-11-19 bug: 78 of 129 runs ungraded, counted as failures, read 14.7%.
    const s = summarizeRun(
      [
        kase('a', [run(), ungradedRun(), ungradedRun()]),
        kase('b', [run(), run({ pass: false, score: 2 }), ungradedRun()], 'buying_signal'),
      ],
      MODELS,
    );
    expect(s).toMatchObject({
      runs: 6,
      graded: 3,
      ungraded: 3,
      ungradedShare: 0.5,
      passes: 2,
      errors: 3,
      modelErrors: 0,
    });
    expect(s.passRate).toBeCloseTo(2 / 3); // not 2/6
    expect(s.meanScore).toBeCloseTo(10 / 3);
    expect(s.byCategory.price_objection).toEqual({
      runs: 3,
      graded: 1,
      ungraded: 2,
      passes: 1,
      passRate: 1,
    });
    expect(tooManyUngraded(s)).toBe(true);
  });

  it('allows up to 5% ungraded (the boundary is exclusive)', () => {
    const twenty = (ungraded: number) =>
      summarizeRun(
        [
          kase(
            'a',
            Array.from({ length: 20 }, (_, i) => (i < ungraded ? ungradedRun() : run())),
          ),
        ],
        MODELS,
      );
    expect(twenty(1).ungradedShare).toBe(UNGRADED_MAX_SHARE);
    expect(tooManyUngraded(twenty(1))).toBe(false);
    expect(tooManyUngraded(twenty(2))).toBe(true);
    expect(tooManyUngraded(twenty(0))).toBe(false);
  });

  it('makes pnpm eval fail when more than 5% of runs are ungraded, or the pass rate is low', () => {
    const base = { runs: 100, ungraded: 0, ungradedShare: 0, passRate: 0.5 };
    const opts = { minPassRate: null, file: 'results/x.json' };
    expect(runProblems(base, opts)).toEqual([]);
    expect(runProblems({ ...base, ungraded: 5, ungradedShare: 0.05 }, opts)).toEqual([]);
    const [problem] = runProblems({ ...base, ungraded: 6, ungradedShare: 0.06 }, opts);
    expect(problem).toBe(
      '6 of 100 runs (6.0%) are ungraded, more than the 5.0% allowed: the pass rate is not trustworthy. Grade them with: pnpm eval rejudge results/x.json',
    );
    expect(runProblems(base, { ...opts, minPassRate: 0.6 })).toEqual([
      'Pass rate 50.0% is below the threshold of 60.0%.',
    ]);
    // Nothing graded: no pass rate, which fails any threshold, and too many ungraded.
    expect(
      runProblems(
        { runs: 3, ungraded: 3, ungradedShare: 1, passRate: null },
        {
          ...opts,
          minPassRate: 0,
        },
      ),
    ).toHaveLength(2);
  });

  it('still counts the latency and cost of ungraded runs (the model did run)', () => {
    const s = summarizeRun([kase('a', [ungradedRun()])], MODELS);
    expect(s.firstTokenMs?.count).toBe(1);
    expect(s.costedRuns).toBe(1);
    expect(s.passRate).toBeNull();
  });
});

describe('pricing', () => {
  it('knows the published Groq prices and nothing else', () => {
    expect(priceOf('openai/gpt-oss-20b')).toEqual({ inputPerMTok: 0.075, outputPerMTok: 0.3 });
    expect(priceOf('toString')).toBeNull();
    expect(
      costUsd('openai/gpt-oss-120b', {
        promptTokens: 1_000_000,
        completionTokens: 0,
        reasoningTokens: null,
      }),
    ).toBe(0.15);
    expect(costUsd('openai/gpt-oss-20b', null)).toBeNull();
  });
});
