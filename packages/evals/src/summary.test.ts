import { describe, expect, it } from 'vitest';
import { costUsd, priceOf } from './pricing';
import { type CaseRecord, type RunRecord, summarizeCase, summarizeRun } from './summary';

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    attempt: 1,
    raw: 'line',
    shown: 'line',
    words: 1,
    checks: [],
    verdict: null,
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

  it('leaves ungraded runs out of the mean but counts them as runs', () => {
    const s = summarizeCase(kase('a', [run({ score: null, pass: false, error: 'x' }), run()]));
    expect(s).toMatchObject({ runs: 2, passes: 1, meanScore: 4, errors: 1 });
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
      price_objection: { runs: 2, passes: 2, passRate: 1 },
      buying_signal: { runs: 2, passes: 1, passRate: 0.5 },
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
