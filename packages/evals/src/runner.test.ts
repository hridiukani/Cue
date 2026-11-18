import {
  LlmError,
  type LlmClient,
  type LlmRequest,
  REASONING_MAX_TOKENS,
  SYSTEM_PROMPT,
} from '@cue/suggest';
import { describe, expect, it } from 'vitest';
import { parseCases } from './cases';
import type { JudgeClient } from './judge';
import { JudgeHttpError, STANDARD_MUST_NOT } from './judge';
import type { ResolvedCase } from './resolve';
import { FIRST_TOKEN_DEADLINE_MS, runCases, type RunnerDeps, Semaphore } from './runner';

/** Fake time: the fake model moves it forward as it "streams". */
class Clock {
  t = 0;
  now = () => this.t;
}

interface Script {
  error?: LlmError;
  firstTokenMs?: number;
  deltas?: string[];
}

/** A model that plays scripted answers in order (the last one repeats) and records requests. */
class FakeLlm implements LlmClient {
  readonly name = 'fake';
  readonly requests: LlmRequest[] = [];
  active = 0;
  maxActive = 0;
  constructor(
    private readonly clock: Clock,
    private readonly scripts: Script[],
  ) {}
  async *stream(req: LlmRequest): AsyncIterable<string> {
    const s = this.scripts[Math.min(this.requests.length, this.scripts.length - 1)] ?? {};
    this.requests.push(req);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await Promise.resolve(); // let other workers start
      if (s.error) throw s.error;
      this.clock.t += s.firstTokenMs ?? 200;
      for (const d of s.deltas ?? ['Ask what ', 'it costs today.']) {
        yield d;
        this.clock.t += 10;
      }
      req.onUsage?.({ promptTokens: 400, completionTokens: 60, reasoningTokens: 30 });
    } finally {
      this.active--;
    }
  }
}

const verdict = (score: number, violated = false) =>
  JSON.stringify({
    must: [{ id: 'M1', met: true }],
    mustNot: STANDARD_MUST_NOT.map((_, i) => ({
      id: `N${String(i + 1)}`,
      violated: violated && i === 0,
    })),
    score,
    rationale: 'fine',
  });

class FakeJudge implements JudgeClient {
  readonly model = 'judge-model';
  calls = 0;
  constructor(private readonly answers: (string | Error)[] = [verdict(5)]) {}
  complete() {
    const a = this.answers[Math.min(this.calls, this.answers.length - 1)] ?? verdict(5);
    this.calls++;
    if (a instanceof Error) return Promise.reject(a);
    return Promise.resolve({
      text: a,
      usage: { promptTokens: 900, completionTokens: 90, reasoningTokens: 50 },
    });
  }
}

function makeCases(n: number): ResolvedCase[] {
  const lines = Array.from({ length: n }, (_, i) =>
    JSON.stringify({
      id: `case-${String(i).padStart(2, '0')}`,
      status: 'DRAFT',
      category: 'price_objection',
      source: { dataset: 'd', license: 'apache-2.0', callId: 'c', utterances: [0, 1] },
      playbook: 'none',
      window: ['Rep: It is 400 a month.', 'Prospect: Too expensive.'],
      rubric: { must: ['Acknowledges the concern'] },
    }),
  );
  return parseCases(lines.join('\n')).map((c) => ({
    case: c,
    window: c.window ?? [],
    playbook: null,
    playbookText: null,
  }));
}

function deps(llm: LlmClient, judge: JudgeClient, clock: Clock, sleeps: number[] = []): RunnerDeps {
  return {
    llm,
    judge,
    now: clock.now,
    sleep: (ms) => {
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
  runsPerCase: 3,
  concurrency: 2,
};

describe('runCases', () => {
  it('runs every case N times and grades each line', async () => {
    const clock = new Clock();
    const llm = new FakeLlm(clock, [{ firstTokenMs: 250 }]);
    const judge = new FakeJudge();
    // Concurrency 1: the fake clock is shared, so parallel fake streams would add up.
    const records = await runCases(
      makeCases(2),
      { ...OPTS, concurrency: 1 },
      deps(llm, judge, clock),
    );
    expect(records.map((r) => r.runs.map((x) => x.attempt))).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ]);
    const run = records[0]?.runs[0];
    expect(run).toMatchObject({
      raw: 'Ask what it costs today.',
      shown: 'Ask what it costs today.',
      pass: true,
      score: 5,
      firstTokenMs: 250,
      overDeadline: false,
      usage: { promptTokens: 400, completionTokens: 60, reasoningTokens: 30 },
      judgeUsage: { promptTokens: 900, completionTokens: 90, reasoningTokens: 50 },
    });
    expect(judge.calls).toBe(6);
  });

  it('sends exactly what production sends: same prompt, sampling and reasoning settings', async () => {
    const clock = new Clock();
    const llm = new FakeLlm(clock, [{}]);
    await runCases(makeCases(1), { ...OPTS, runsPerCase: 1 }, deps(llm, new FakeJudge(), clock));
    const req = llm.requests[0];
    expect(req?.messages[0]?.content).toBe(SYSTEM_PROMPT);
    expect(req?.messages.at(-1)?.content).toContain('Prospect: Too expensive.');
    expect(req).toMatchObject({
      model: 'openai/gpt-oss-20b',
      temperature: 0.3,
      maxTokens: REASONING_MAX_TOKENS,
      reasoningEffort: 'low',
      includeReasoning: false,
    });
  });

  it('never runs more than `concurrency` generations at once', async () => {
    const clock = new Clock();
    const llm = new FakeLlm(clock, [{}]);
    await runCases(makeCases(5), { ...OPTS, concurrency: 2 }, deps(llm, new FakeJudge(), clock));
    expect(llm.requests).toHaveLength(15);
    expect(llm.maxActive).toBe(2);
  });

  it('flags a first token later than the 1.5 s production deadline', async () => {
    const clock = new Clock();
    const llm = new FakeLlm(clock, [{ firstTokenMs: FIRST_TOKEN_DEADLINE_MS + 1 }]);
    const [r] = await runCases(
      makeCases(1),
      { ...OPTS, runsPerCase: 1 },
      deps(llm, new FakeJudge(), clock),
    );
    expect(r?.runs[0]).toMatchObject({ overDeadline: true, firstTokenMs: 1501, pass: true });
  });

  it('waits out a 429 and retries; latency is the successful attempt only', async () => {
    const clock = new Clock();
    const sleeps: number[] = [];
    const llm = new FakeLlm(clock, [
      { error: new LlmError('rate_limited', 'rl', { status: 429, retryAfterMs: 2000 }) },
      { firstTokenMs: 300 },
    ]);
    const [r] = await runCases(
      makeCases(1),
      { ...OPTS, runsPerCase: 1 },
      deps(llm, new FakeJudge(), clock, sleeps),
    );
    expect(sleeps).toEqual([2000]);
    expect(r?.runs[0]).toMatchObject({ pass: true, firstTokenMs: 300, error: null });
  });

  it('records a non-retryable model error as a failed run without asking the judge', async () => {
    const clock = new Clock();
    const judge = new FakeJudge();
    const llm = new FakeLlm(clock, [{ error: new LlmError('http', 'HTTP 500') }]);
    const [r] = await runCases(makeCases(1), { ...OPTS, runsPerCase: 1 }, deps(llm, judge, clock));
    expect(r?.runs[0]).toMatchObject({
      pass: false,
      score: null,
      error: 'model: HTTP 500',
      firstTokenMs: null,
    });
    expect(judge.calls).toBe(0);
  });

  it('gives up retrying 429s after maxRetries', async () => {
    const clock = new Clock();
    const llm = new FakeLlm(clock, [
      { error: new LlmError('rate_limited', 'rate limited', { status: 429, retryAfterMs: 100 }) },
    ]);
    const [r] = await runCases(
      makeCases(1),
      { ...OPTS, runsPerCase: 1, maxRetries: 2 },
      deps(llm, new FakeJudge(), clock),
    );
    expect(llm.requests).toHaveLength(3);
    expect(r?.runs[0]?.error).toBe('model: rate limited');
  });

  it('waits out a rate-limited judge and reports each wait', async () => {
    const clock = new Clock();
    const sleeps: number[] = [];
    const limited = new JudgeHttpError(429, 'judge HTTP 429', 7000);
    const judge = new FakeJudge([limited, limited, verdict(4)]);
    const waits: [string, number][] = [];
    const [r] = await runCases(
      makeCases(1),
      { ...OPTS, runsPerCase: 1 },
      {
        ...deps(new FakeLlm(clock, [{}]), judge, clock, sleeps),
        onRateLimited: (who, ms) => waits.push([who, ms]),
      },
    );
    expect(r?.runs[0]).toMatchObject({ pass: true, judgeError: null });
    expect(sleeps).toEqual([7000, 7000]);
    expect(waits).toEqual([
      ['judge', 7000],
      ['judge', 7000],
    ]);
  });

  it('keeps judge calls under judgeConcurrency, separately from generation', async () => {
    const clock = new Clock();
    let active = 0;
    let maxActive = 0;
    const slowJudge: JudgeClient = {
      model: 'judge-model',
      async complete() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 2));
        active--;
        return { text: verdict(5), usage: null };
      },
    };
    await runCases(
      makeCases(6),
      { ...OPTS, runsPerCase: 1, concurrency: 6, judgeConcurrency: 2 },
      deps(new FakeLlm(clock, [{}]), slowJudge, clock),
    );
    expect(maxActive).toBe(2);
  });

  it('scores an empty answer 1 and skips the judge', async () => {
    const clock = new Clock();
    const judge = new FakeJudge();
    const llm = new FakeLlm(clock, [{ deltas: ['  '] }]);
    const [r] = await runCases(makeCases(1), { ...OPTS, runsPerCase: 1 }, deps(llm, judge, clock));
    expect(r?.runs[0]).toMatchObject({ pass: false, score: 1, shown: '' });
    expect(judge.calls).toBe(0);
  });

  it('asks the judge once more after an unreadable verdict, then gives up', async () => {
    const clock = new Clock();
    const once = new FakeJudge(['nope', verdict(4)]);
    const [a] = await runCases(
      makeCases(1),
      { ...OPTS, runsPerCase: 1 },
      deps(new FakeLlm(clock, [{}]), once, clock),
    );
    expect(a?.runs[0]).toMatchObject({ pass: true, score: 4 });
    expect(once.calls).toBe(2);
    // Both judge calls were billed, so both count toward the judge's cost.
    expect(a?.runs[0]?.judgeUsage).toEqual({
      promptTokens: 1800,
      completionTokens: 180,
      reasoningTokens: 100,
    });

    const never = new FakeJudge(['nope']);
    const [b] = await runCases(
      makeCases(1),
      { ...OPTS, runsPerCase: 1 },
      deps(new FakeLlm(clock, [{}]), never, clock),
    );
    expect(b?.runs[0]).toMatchObject({
      pass: false,
      score: null,
      judgeError: 'judge did not return JSON',
    });
    expect(never.calls).toBe(2);
  });

  it('fails a line the judge says breaks a must-not, even with a high score', async () => {
    const clock = new Clock();
    const [r] = await runCases(
      makeCases(1),
      { ...OPTS, runsPerCase: 1 },
      deps(new FakeLlm(clock, [{}]), new FakeJudge([verdict(5, true)]), clock),
    );
    expect(r?.runs[0]).toMatchObject({ pass: false, score: 2 });
    expect(r?.runs[0]?.reasons).toContain('violates N1');
  });

  it('rejects a non-positive run count', async () => {
    const clock = new Clock();
    await expect(
      runCases(
        makeCases(1),
        { ...OPTS, runsPerCase: 0 },
        deps(new FakeLlm(clock, [{}]), new FakeJudge(), clock),
      ),
    ).rejects.toThrow(/positive integer/);
  });
});

describe('Semaphore', () => {
  it('lets at most `size` run at once and admits waiters in order', async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    let release: () => void = () => undefined;
    const first = sem.run(
      () =>
        new Promise<void>((r) => {
          order.push('a start');
          release = r;
        }),
    );
    const second = sem.run(() => {
      order.push('b start');
      return Promise.resolve();
    });
    const third = sem.run(() => {
      order.push('c start');
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(order).toEqual(['a start']);
    release();
    await Promise.all([first, second, third]);
    expect(order).toEqual(['a start', 'b start', 'c start']);
  });

  it('releases its slot when the task throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(sem.run(() => Promise.resolve(42))).resolves.toBe(42);
  });
});
