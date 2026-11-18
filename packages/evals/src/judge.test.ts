import { describe, expect, it } from 'vitest';
import {
  allMustNot,
  buildJudgeMessages,
  GroqJudgeClient,
  JudgeHttpError,
  parseVerdict,
  STANDARD_MUST_NOT,
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
        fetch: () => Promise.resolve(res),
      });
    const limited = mk(new Response('', { status: 429, headers: { 'retry-after': '3' } }));
    await expect(limited.complete([])).rejects.toMatchObject({ status: 429, retryAfterMs: 3000 });
    const broken = mk(new Response('', { status: 500 }));
    await expect(broken.complete([])).rejects.toBeInstanceOf(JudgeHttpError);
    const odd = mk(Response.json({ nope: true }));
    await expect(odd.complete([])).rejects.toThrow(/unexpected response/);
  });
});
