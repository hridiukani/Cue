import { describe, expect, it } from 'vitest';
import { JUDGE_PINNED } from './config';
import {
  allMustNot,
  buildJudgeMessages,
  GroqJudgeClient,
  JudgeHttpError,
  judgeSettingsKey,
  parseDuration,
  parseRateLimit,
  parseVerdict,
  STANDARD_MUST_NOT,
  LEGACY_JUDGE_SETTINGS,
} from './judge';

const verdictJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    must: [
      { id: 'M1', met: true },
      { id: 'M2', met: false },
    ],
    mustNot: [
      { id: 'N1', violated: false },
      { id: 'N2', violated: false },
      { id: 'N3', violated: false },
      { id: 'N4', violated: false },
    ],
    score: 4,
    rationale: 'Asks a specific question about cost.',
    ...over,
  });

describe('buildJudgeMessages', () => {
  it('numbers the rubric and puts the standard must-nots before the case ones', () => {
    const [system, user] = buildJudgeMessages({
      window: [
        { speaker: 'rep', text: 'Shall we look at pricing?' },
        { speaker: 'prospect', text: 'It is too expensive.' },
      ],
      playbookText: null,
      suggestion: 'What would it cost to keep doing it by hand?',
      must: ['Acknowledges the concern', 'Asks about the cost of the status quo'],
      mustNot: ['Offers a discount'],
    });
    expect(system?.content).toContain('Score 1-5');
    const text = user?.content ?? '';
    expect(text).toContain('Prospect: It is too expensive.');
    expect(text).toContain('<<<What would it cost to keep doing it by hand?>>>');
    expect(text).toContain('M2. Asks about the cost of the status quo');
    expect(text).toContain(`N1. ${STANDARD_MUST_NOT[0]}`);
    expect(text).toContain(`N${String(STANDARD_MUST_NOT.length + 1)}. Offers a discount`);
    expect(text).toContain('(none: the coach had no product playbook)');
  });

  it('allMustNot keeps the order the judge is shown', () => {
    expect(allMustNot(['x'])).toEqual([...STANDARD_MUST_NOT, 'x']);
  });
});

describe('parseVerdict', () => {
  it('reads a valid verdict in rubric order', () => {
    expect(parseVerdict(verdictJson(), 2, 4)).toEqual({
      ok: true,
      verdict: {
        mustMet: [true, false],
        mustNotViolated: [false, false, false, false],
        score: 4,
        rationale: 'Asks a specific question about cost.',
      },
    });
  });

  it('caps the score at 2 when a must-not is violated, even if the judge forgot', () => {
    const json = verdictJson({
      mustNot: [
        { id: 'N1', violated: true },
        { id: 'N2', violated: false },
        { id: 'N3', violated: false },
        { id: 'N4', violated: false },
      ],
      score: 5,
    });
    const r = parseVerdict(json, 2, 4);
    expect(r.ok && r.verdict.score).toBe(2);
  });

  it.each([
    ['not JSON', 'Score: 4', /did not return JSON/],
    ['score out of range', verdictJson({ score: 6 }), /wrong shape/],
    ['fractional score', verdictJson({ score: 3.5 }), /wrong shape/],
    ['empty rationale', verdictJson({ rationale: ' ' }), /wrong shape/],
    ['missing must id', verdictJson({ must: [{ id: 'M1', met: true }] }), /M1\.\.M2/],
    [
      'ids out of order',
      verdictJson({
        must: [
          { id: 'M2', met: true },
          { id: 'M1', met: true },
        ],
      }),
      /M1\.\.M2/,
    ],
    ['too few must-nots', verdictJson({ mustNot: [{ id: 'N1', violated: false }] }), /N1\.\.N4/],
  ])('rejects %s', (_name, text, error) => {
    const r = parseVerdict(text, 2, 4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(error);
  });

  it('accepts lower-case ids and trims the rationale to 300 chars', () => {
    const json = verdictJson({
      must: [
        { id: 'm1', met: true },
        { id: 'm2', met: true },
      ],
      rationale: 'x'.repeat(500),
    });
    const r = parseVerdict(json, 2, 4);
    expect(r.ok && r.verdict.rationale.length).toBe(300);
  });
});

describe('GroqJudgeClient', () => {
  it('asks for JSON at temperature 0 and returns text and usage', async () => {
    let body: Record<string, unknown> = {};
    const client = new GroqJudgeClient('openai/gpt-oss-120b', {
      apiKey: 'k',
      baseUrl: 'http://groq.test/v1/',
      settings: LEGACY_JUDGE_SETTINGS,
      fetch: (url, init) => {
        expect(url).toBe('http://groq.test/v1/chat/completions');
        body = JSON.parse(init.body as string) as Record<string, unknown>;
        return Promise.resolve(
          Response.json({
            choices: [{ message: { role: 'assistant', content: '{"a":1}' } }],
            usage: {
              prompt_tokens: 300,
              completion_tokens: 80,
              completion_tokens_details: { reasoning_tokens: 50 },
            },
          }),
        );
      },
    });
    const r = await client.complete([{ role: 'user', content: 'grade' }]);
    expect(r).toEqual({
      text: '{"a":1}',
      usage: { promptTokens: 300, completionTokens: 80, reasoningTokens: 50 },
    });
    expect(body).toMatchObject({
      model: 'openai/gpt-oss-120b',
      temperature: 0,
      response_format: { type: 'json_object' },
      reasoning_effort: 'medium',
    });
  });

  it('surfaces 429 with retry-after, and other HTTP errors', async () => {
    const mk = (res: Response) =>
      new GroqJudgeClient('m', {
        apiKey: 'k',
        baseUrl: 'http://x',
        settings: JUDGE_PINNED.settings,
        fetch: () => Promise.resolve(res),
      });
    const limited = mk(new Response('', { status: 429, headers: { 'retry-after': '3' } }));
    await expect(limited.complete([])).rejects.toMatchObject({ status: 429, retryAfterMs: 3000 });
    const broken = mk(new Response('', { status: 500 }));
    await expect(broken.complete([])).rejects.toBeInstanceOf(JudgeHttpError);
    const odd = mk(Response.json({ nope: true }));
    await expect(odd.complete([])).rejects.toThrow(/unexpected response/);
  });

  it('sends the configured reasoning effort and token budget', async () => {
    let body: Record<string, unknown> = {};
    const client = new GroqJudgeClient('openai/gpt-oss-120b', {
      apiKey: 'k',
      baseUrl: 'http://x',
      settings: JUDGE_PINNED.settings,
      fetch: (_url, init) => {
        body = JSON.parse(init.body as string) as Record<string, unknown>;
        return Promise.resolve(Response.json({ choices: [{ message: { content: '{}' } }] }));
      },
    });
    await client.complete([]);
    expect(body).toMatchObject({ reasoning_effort: 'low', max_completion_tokens: 512 });
    expect(judgeSettingsKey(client.settings)).toBe('low/512');
  });

  it('says which limit a 429 hit, from the provider message, without the org id', async () => {
    const res = new Response(
      JSON.stringify({
        error: {
          message:
            'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_01abcDEF` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199624, Requested 1543. Please try again in 8m12.345s. Need more tokens?',
          type: 'tokens',
          code: 'rate_limit_exceeded',
        },
      }),
      {
        status: 429,
        headers: {
          'retry-after': '493',
          'x-ratelimit-limit-requests': '1000',
          'x-ratelimit-remaining-requests': '612',
          'x-ratelimit-limit-tokens': '8000',
          'x-ratelimit-remaining-tokens': '7100',
        },
      },
    );
    const client = new GroqJudgeClient('m', {
      apiKey: 'k',
      baseUrl: 'http://x',
      settings: JUDGE_PINNED.settings,
      fetch: () => Promise.resolve(res),
    });
    const err: unknown = await client.complete([]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JudgeHttpError);
    const e = err as JudgeHttpError;
    expect(e.message).toBe('judge HTTP 429 (tokens per day)');
    expect(e.rateLimit?.kind).toBe('tokens per day');
    expect(e.rateLimit?.message).toContain('organization `org_…`');
    expect(e.rateLimit?.message).not.toContain('org_01abcDEF');
    expect(e.retryAfterMs).toBe(493_000); // the later of retry-after (493 s) and the message (492.3 s)
    expect(e.rateLimit?.headers).toMatchObject({ limitRequests: '1000', remainingTokens: '7100' });
  });
});

describe('parseRateLimit', () => {
  const headers = (h: Record<string, string>) => new Headers(h);

  it('reads the limit name from each kind of message', () => {
    for (const [code, kind] of [
      ['RPM', 'requests per minute'],
      ['RPD', 'requests per day'],
      ['TPM', 'tokens per minute'],
      ['TPD', 'tokens per day'],
    ] as const) {
      const body = JSON.stringify({
        error: { message: `Rate limit reached on x (${code}): Limit 1` },
      });
      expect(parseRateLimit(headers({}), body).kind).toBe(kind);
    }
  });

  it('falls back to whichever remaining header is 0 when the body says nothing', () => {
    expect(parseRateLimit(headers({ 'x-ratelimit-remaining-tokens': '0' }), '').kind).toBe(
      'tokens per minute',
    );
    expect(parseRateLimit(headers({ 'x-ratelimit-remaining-requests': '0' }), 'oops').kind).toBe(
      'requests per day',
    );
    expect(parseRateLimit(headers({}), '').kind).toBe('unknown');
    expect(parseRateLimit(headers({}), '').retryAfterMs).toBeNull();
  });

  it('takes the wait from the message when there is no retry-after header', () => {
    const body = JSON.stringify({ error: { message: 'x (TPM): Please try again in 1m26.4s.' } });
    expect(parseRateLimit(headers({}), body).retryAfterMs).toBe(86_400);
  });
});

describe('parseDuration', () => {
  it('reads Groq-style durations', () => {
    expect(parseDuration('7.66s')).toBe(7660);
    expect(parseDuration('1m26.4s')).toBe(86_400);
    expect(parseDuration('2h3m')).toBe(7_380_000);
    expect(parseDuration('450ms')).toBe(450);
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration('5s later')).toBeNull();
  });
});
