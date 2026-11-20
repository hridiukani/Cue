import { describe, expect, it } from 'vitest';
import { JUDGE_PINNED } from './config';
import { parseCases, rubricHash } from './cases';
import { fakeRunFile } from './fixtures.test-helpers';
import { type JudgeClient, JudgeHttpError, type RateLimitInfo, STANDARD_MUST_NOT } from './judge';
import { describeRateLimits, newRateLimitStats, recordRateLimit } from './rate-limits';
import { type ResolveById, rejudgeRun } from './rejudge';
import type { ResolvedCase } from './resolve';
import { runFileName } from './results';
import { JudgeGate } from './runner';
import { isUngraded } from './scoring';
import type { CaseRecord, RunRecord } from './summary';

const [evalCase] = parseCases(
  JSON.stringify({
    id: 'price-01',
    status: 'DRAFT',
    category: 'price_objection',
    source: { dataset: 'd', license: 'apache-2.0', callId: 'c', utterances: [0, 1] },
    playbook: 'none',
    window: ['Rep: It is 400 a month.', 'Prospect: Too expensive.'],
    rubric: { must: ['Acknowledges the concern'] },
  }),
);
if (!evalCase) throw new Error('fixture');
const resolved: ResolvedCase = {
  case: evalCase,
  window: [
    { speaker: 'rep', text: 'It is 400 a month.' },
    { speaker: 'prospect', text: 'Too expensive.' },
  ],
  playbook: null,
  playbookText: null,
};
const resolveOk: ResolveById = () => Promise.resolve({ ok: true, resolved });

const verdictJson = (score: number) =>
  JSON.stringify({
    must: [{ id: 'M1', met: score >= 4 }],
    mustNot: STANDARD_MUST_NOT.map((_, i) => ({ id: `N${String(i + 1)}`, violated: false })),
    score,
    rationale: 'ok',
  });

class ScriptedJudge implements JudgeClient {
  readonly model = 'openai/gpt-oss-120b';
  readonly settings = JUDGE_PINNED.settings;
  readonly seen: string[] = [];
  constructor(private readonly answers: (string | Error)[]) {}
  complete(messages: { role: string; content: string }[]) {
    const a = this.answers[Math.min(this.seen.length, this.answers.length - 1)] ?? verdictJson(5);
    this.seen.push(messages.at(-1)?.content ?? '');
    if (a instanceof Error) return Promise.reject(a);
    return Promise.resolve({
      text: a,
      usage: { promptTokens: 1000, completionTokens: 120, reasoningTokens: 60 },
    });
  }
}

const graded = (line: string, score: number): Partial<RunRecord> => ({
  shown: line,
  raw: line,
  pass: score >= 4,
  score,
  verdict: { mustMet: [true], mustNotViolated: [false, false, false], score, rationale: 'ok' },
});
const ungraded = (line: string): Partial<RunRecord> => ({
  shown: line,
  raw: line,
  pass: false,
  score: null,
  verdict: null,
  judgeError: 'judge HTTP 429',
  judgeUsage: null,
  reasons: ['ungraded: judge HTTP 429'],
});

function caseWith(runs: Partial<RunRecord>[], hash = rubricHash(resolved.case)): CaseRecord {
  return {
    id: 'price-01',
    category: 'price_objection',
    dataset: 'd',
    license: 'apache-2.0',
    rubricHash: hash,
    playbook: 'none',
    status: 'DRAFT',
    runs: runs.map((over, i) => ({
      attempt: i + 1,
      raw: '',
      shown: '',
      words: 6,
      checks: [{ id: 'max_words', pass: true }],
      verdict: null,
      judgeError: null,
      error: null,
      pass: false,
      score: null,
      reasons: [],
      firstTokenMs: 300 + i,
      overDeadline: false,
      usage: { promptTokens: 500, completionTokens: 40, reasoningTokens: 20 },
      judgeUsage: null,
      ...over,
    })),
  };
}

const noWait = { now: () => 0, sleep: () => Promise.resolve() };
const deps = (judge: JudgeClient, maxWaitMs = 900_000) => ({
  judge,
  gate: new JudgeGate(1, 0, noWait),
  maxWaitMs,
  createdAt: () => '2026-11-19T12:00:00.000Z',
  git: { commit: 'feedface', dirty: false },
});

describe('rejudgeRun', () => {
  it('grades only the ungraded runs, from the saved line, and keeps everything the model measured', async () => {
    const source = fakeRunFile([
      caseWith([
        graded('That price is a lot.', 4),
        ungraded('Fair, it is a big step. What would it replace?'),
        ungraded('Is budget the only concern?'),
      ]),
    ]);
    const before = source.cases[0]?.runs ?? [];
    const judge = new ScriptedJudge([verdictJson(5), verdictJson(3)]);
    const { run, info } = await rejudgeRun(
      { file: 'results/a.json', run: source },
      resolveOk,
      deps(judge),
    );

    expect(judge.seen).toHaveLength(2); // the graded run wasn't sent again
    expect(judge.seen[0]).toContain('<<<Fair, it is a big step. What would it replace?>>>');
    const after = run.cases[0]?.runs ?? [];
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toMatchObject({
      pass: true,
      score: 5,
      judgeError: null,
      rejudged: true,
      judgeSettings: JUDGE_PINNED.settings,
      // Untouched: the line, its latency and the model's tokens.
      shown: before[1]?.shown,
      firstTokenMs: before[1]?.firstTokenMs,
      usage: before[1]?.usage,
    });
    expect(after[2]).toMatchObject({ pass: false, score: 3, reasons: ['score 3 < 4'] });
    expect(info).toMatchObject({ regraded: 2, stillUngraded: 0, skipped: [] });
    expect(run.summary).toMatchObject({ graded: 3, ungraded: 0, passes: 2 });
    expect(run.summary.gradedBy).toEqual({ 'medium/1024': 1, 'low/512': 2 });
  });

  it('writes a new run: new id and time, the original commit and prompt, and where it came from', async () => {
    const source = fakeRunFile([caseWith([ungraded('Fair point.')])]);
    const { run } = await rejudgeRun(
      { file: 'results/a.json', run: source },
      resolveOk,
      deps(new ScriptedJudge([verdictJson(4)])),
    );
    expect(run.meta.runId).not.toBe(source.meta.runId);
    expect(run.meta.createdAt).toBe('2026-11-19T12:00:00.000Z');
    expect(run.meta.git).toEqual(source.meta.git); // the generation's commit
    expect(run.meta.promptVersion).toBe(source.meta.promptVersion);
    expect(run.meta.rejudge).toMatchObject({
      of: { file: 'results/a.json', runId: source.meta.runId },
      judgeSettings: JUDGE_PINNED.settings,
      git: { commit: 'feedface', dirty: false },
    });
    expect(runFileName(run.meta)).toBe(
      '20261119T120000Z_openai-gpt-oss-20b_suggest-v1_rejudged.json',
    );
  });

  it('skips a case whose rubric changed since the run, rather than mixing two rubrics', async () => {
    const source = fakeRunFile([caseWith([ungraded('Fair point.')], 'old-hash')]);
    const judge = new ScriptedJudge([verdictJson(5)]);
    const { run, info } = await rejudgeRun({ file: 'a.json', run: source }, resolveOk, deps(judge));
    expect(judge.seen).toHaveLength(0);
    expect(info.skipped[0]?.reason).toMatch(/rubric, playbook or window changed/);
    expect(info.stillUngraded).toBe(1);
    expect(run.summary.ungraded).toBe(1);
  });

  it('skips a case that is no longer in the dataset', async () => {
    const source = fakeRunFile([caseWith([ungraded('Fair point.')])]);
    const { info } = await rejudgeRun(
      { file: 'a.json', run: source },
      () => Promise.resolve({ ok: false, reason: 'no longer in dataset/cases.jsonl' }),
      deps(new ScriptedJudge([])),
    );
    expect(info.skipped).toEqual([
      { caseId: 'price-01', reason: 'no longer in dataset/cases.jsonl' },
    ]);
  });

  it('stops at a daily limit, leaves the rest ungraded and reports which limit it was', async () => {
    const info: RateLimitInfo = {
      kind: 'tokens per day',
      message: 'Rate limit reached ... on tokens per day (TPD): Limit 200000, Used 199990',
      retryAfterMs: 30 * 60_000,
      headers: {
        limitRequests: '1000',
        remainingRequests: '700',
        resetRequests: '1m',
        limitTokens: '8000',
        remainingTokens: '8000',
        resetTokens: '0s',
      },
    };
    const daily = new JudgeHttpError(
      429,
      'judge HTTP 429 (tokens per day)',
      info.retryAfterMs,
      info,
    );
    const source = fakeRunFile([
      caseWith([ungraded('a b c'), ungraded('d e f'), ungraded('g h i')]),
    ]);
    const judge = new ScriptedJudge([verdictJson(4), daily]);
    const result = await rejudgeRun(
      { file: 'a.json', run: source },
      resolveOk,
      deps(judge, 900_000),
    );
    expect(judge.seen).toHaveLength(2); // one success, one 429, then no more calls
    expect(result.info).toMatchObject({ regraded: 1, stillUngraded: 2 });
    expect(result.lastRateLimit?.kind).toBe('tokens per day');
    const last = result.run.cases[0]?.runs[2];
    expect(last && isUngraded(last)).toBe(true);
    expect(last?.judgeError).toMatch(/tokens per day.*30\.0 min, more than the 15\.0 min allowed/);
  });
});

describe('rate limit stats', () => {
  it('counts 429s by limit and keeps the last provider message', () => {
    const stats = newRateLimitStats();
    const tpm: RateLimitInfo = {
      kind: 'tokens per minute',
      message: 'on tokens per minute (TPM): Limit 8000, Used 7900, Requested 1500',
      retryAfterMs: 11_000,
      headers: {
        limitRequests: '1000',
        remainingRequests: '880',
        resetRequests: '2m',
        limitTokens: '8000',
        remainingTokens: '100',
        resetTokens: '11s',
      },
    };
    recordRateLimit(stats, 'judge', tpm, false);
    recordRateLimit(stats, 'judge', tpm, false);
    recordRateLimit(stats, 'model', null, false);
    expect(stats.judge).toEqual({ 'tokens per minute': 2 });
    expect(stats.model).toEqual({ unknown: 1 });
    const text = describeRateLimits(stats).join('\n');
    expect(text).toContain('Judge rate limits hit: tokens per minute ×2');
    expect(text).toContain('requests/day 880 of 1000 left, tokens/min 100 of 8000 left');
    expect(text).toContain('Provider said: on tokens per minute (TPM)');
    expect(describeRateLimits(newRateLimitStats())).toEqual([]);
  });
});
