import { LlmError, type LlmClient, type LlmRequest } from '@cue/suggest';
import { describe, expect, it } from 'vitest';
import { parseCases } from './cases';
import {
  checksProblems,
  formatChecks,
  runChecksOnly,
  summarizeChecks,
  type CheckedLine,
} from './checks-run';
import type { ResolvedCase } from './resolve';

/** A model that answers from a script, in order (the last answer repeats). */
class ScriptedLlm implements LlmClient {
  readonly name = 'scripted';
  readonly requests: LlmRequest[] = [];
  constructor(
    private readonly answers: (string | LlmError)[],
    private readonly clock: { t: number },
  ) {}
  async *stream(req: LlmRequest): AsyncIterable<string> {
    const a = this.answers[Math.min(this.requests.length, this.answers.length - 1)] ?? '';
    this.requests.push(req);
    await Promise.resolve();
    if (a instanceof LlmError) throw a;
    this.clock.t += 300;
    yield a;
  }
}

function makeCases(n: number): ResolvedCase[] {
  const lines = Array.from({ length: n }, (_, i) =>
    JSON.stringify({
      id: `case-${String(i)}`,
      status: 'DRAFT',
      category: 'price_objection',
      source: { dataset: 'd', license: 'apache-2.0', callId: 'c', utterances: [0, 1] },
      playbook: 'none',
      window: ['Rep: It is 400 a month.', 'Prospect: Too expensive.'],
      rubric: { must: ['Acknowledges the concern'], bannedPhrases: ['guarantee'] },
    }),
  );
  return parseCases(lines.join('\n')).map((c) => ({
    case: c,
    window: c.window ?? [],
    playbook: null,
    playbookText: null,
  }));
}

function deps(llm: LlmClient, clock: { t: number }, sleeps: number[] = []) {
  return {
    llm,
    now: () => clock.t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
      return Promise.resolve();
    },
    timeout: () => new AbortController().signal,
  };
}

const OPTS = {
  model: 'openai/gpt-oss-20b',
  promptVersion: 'suggest-v1',
  runsPerCase: 2,
  concurrency: 1,
};

const LONG = Array.from({ length: 25 }, (_, i) => `w${String(i)}`).join(' ');

describe('runChecksOnly', () => {
  it('generates every case N times with the production prompt and needs no judge', async () => {
    const clock = { t: 0 };
    const llm = new ScriptedLlm(['What does matching cost you today?'], clock);
    const lines = await runChecksOnly(makeCases(2), OPTS, deps(llm, clock));
    expect(lines).toHaveLength(4);
    expect(llm.requests).toHaveLength(4);
    expect(llm.requests[0]?.model).toBe('openai/gpt-oss-20b');
    expect(lines.every((l) => l.pass)).toBe(true);
    expect(lines.map((l) => `${l.caseId}#${String(l.attempt)}`)).toEqual([
      'case-0#1',
      'case-0#2',
      'case-1#1',
      'case-1#2',
    ]);
    expect(lines[0]?.firstTokenMs).toBe(300);
  });

  it('fails a line on any check: too long, a preamble, a banned phrase', async () => {
    const clock = { t: 0 };
    const llm = new ScriptedLlm(
      [LONG, "Sure! Here's a line: Ask about budget.", 'We guarantee it pays for itself.', 'Ok?'],
      clock,
    );
    const lines = await runChecksOnly(makeCases(4), { ...OPTS, runsPerCase: 1 }, deps(llm, clock));
    const failed = (i: number) =>
      lines[i]?.checks.filter((c) => !c.pass).map((c) => c.id) ?? ['missing'];
    expect(failed(0)).toEqual(['max_words']);
    expect(lines[0]?.words).toBe(25);
    expect(failed(1)).toEqual(['no_preamble']);
    expect(failed(2)).toEqual(['no_banned_phrases']);
    expect(lines.map((l) => l.pass)).toEqual([false, false, false, true]);
  });

  it('counts a model error as a failed line (the rep would get nothing)', async () => {
    const clock = { t: 0 };
    const llm = new ScriptedLlm([new LlmError('http', 'model HTTP 500')], clock);
    const [line] = await runChecksOnly(makeCases(1), { ...OPTS, runsPerCase: 1 }, deps(llm, clock));
    expect(line?.pass).toBe(false);
    expect(line?.error).toMatch(/^model: /);
    expect(line?.checks).toEqual([]);
  });

  it('waits out a model rate limit and retries', async () => {
    const clock = { t: 0 };
    const sleeps: number[] = [];
    const llm = new ScriptedLlm(
      [new LlmError('rate_limited', '429', { retryAfterMs: 5000 }), 'What does it cost today?'],
      clock,
    );
    const [line] = await runChecksOnly(
      makeCases(1),
      { ...OPTS, runsPerCase: 1 },
      deps(llm, clock, sleeps),
    );
    expect(sleeps).toEqual([5000]);
    expect(line?.pass).toBe(true);
  });
});

const line = (over: Partial<CheckedLine>): CheckedLine => ({
  caseId: 'c',
  attempt: 1,
  shown: 'Ask about budget.',
  words: 3,
  checks: [{ id: 'max_words', pass: true }],
  error: null,
  pass: true,
  firstTokenMs: 300,
  ...over,
});

describe('summarizeChecks and checksProblems', () => {
  const lines = [
    line({}),
    line({ firstTokenMs: 1600 }),
    line({
      pass: false,
      words: 27,
      checks: [{ id: 'max_words', pass: false, detail: '27 words' }],
    }),
    line({ pass: false, error: 'model: boom', checks: [], firstTokenMs: null }),
  ];

  it('counts passes, failed checks, over-long lines, errors and first-token latency', () => {
    const s = summarizeChecks(lines);
    expect(s).toMatchObject({
      lines: 4,
      passes: 2,
      passRate: 0.5,
      modelErrors: 1,
      failedChecks: { max_words: 1 },
      overWords: { count: 1, max: 27 },
      firstTokenMs: { p50: 300, p95: 1600, overDeadline: 1 },
    });
  });

  it('fails only below the threshold, and never without one', () => {
    const s = summarizeChecks(lines);
    expect(checksProblems(s, null)).toEqual([]);
    expect(checksProblems(s, 0.5)).toEqual([]);
    expect(checksProblems(s, 0.6)).toEqual([
      'Deterministic pass rate 50.0% (2 of 4 lines) is below the threshold of 60.0%.',
    ]);
  });

  it('reports which lines failed and why', () => {
    const text = formatChecks(summarizeChecks(lines), lines, {
      model: 'm',
      promptVersion: 'suggest-v1',
    });
    expect(text).toContain('Deterministic checks only (no judge): m, prompt suggest-v1');
    expect(text).toContain('Pass rate      50.0% (2 of 4 lines pass every check)');
    expect(text).toContain('Over 20 words  1 (longest 27)');
    expect(text).toContain('c #1: 27 words');
    expect(text).toContain('c #1: model: boom');
  });

  it('handles an empty run', () => {
    expect(summarizeChecks([])).toMatchObject({ lines: 0, passRate: 0, firstTokenMs: null });
  });
});
