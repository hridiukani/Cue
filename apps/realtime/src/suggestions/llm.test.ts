import { describe, expect, it } from 'vitest';
import { GroqClient, LlmError, type LlmRequest } from './llm';

const REQ: LlmRequest = {
  model: 'llama-3.1-8b-instant',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 48,
  temperature: 0.3,
  stop: ['\n'],
};

/** A streaming Response whose body arrives in the given raw pieces. */
function sse(pieces: string[], init: ResponseInit = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

const chunk = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

async function collect(
  client: GroqClient,
  signal = new AbortController().signal,
): Promise<string[]> {
  const out: string[] = [];
  for await (const d of client.stream(REQ, signal)) out.push(d);
  return out;
}

describe('GroqClient', () => {
  it('sends an OpenAI-compatible streaming request with a bearer token', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const client = new GroqClient({
      apiKey: 'gsk_test',
      baseUrl: 'https://api.groq.com/openai/v1/',
      fetch: (url, init) => {
        seen = { url, init };
        return Promise.resolve(sse(['data: [DONE]\n\n']));
      },
    });
    await collect(client);
    const s = seen as { url: string; init: RequestInit } | null;
    expect(s?.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((s?.init.headers as Record<string, string>).authorization).toBe('Bearer gsk_test');
    expect(JSON.parse(s?.init.body as string)).toEqual({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      n: 1,
      max_completion_tokens: 48,
      temperature: 0.3,
      stop: ['\n'],
    });
  });

  it('yields deltas even when SSE events are split across network chunks', async () => {
    const whole =
      chunk('Ask ') + ': keep-alive\n\n' + chunk('what it ') + chunk('costs.') + 'data: [DONE]\n\n';
    const pieces = [whole.slice(0, 7), whole.slice(7, 40), whole.slice(40, 41), whole.slice(41)];
    const client = new GroqClient({
      apiKey: 'k',
      baseUrl: 'http://x',
      fetch: () => Promise.resolve(sse(pieces)),
    });
    expect(await collect(client)).toEqual(['Ask ', 'what it ', 'costs.']);
  });

  it('skips chunks with no content (role-only first chunk, final usage chunk)', async () => {
    const pieces = [
      `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`,
      chunk('Hi'),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], x_groq: { id: 'req_1' } })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const client = new GroqClient({
      apiKey: 'k',
      baseUrl: 'http://x',
      fetch: () => Promise.resolve(sse(pieces)),
    });
    expect(await collect(client)).toEqual(['Hi']);
  });

  it('maps 429 to rate_limited with retry-after in ms', async () => {
    const client = new GroqClient({
      apiKey: 'k',
      baseUrl: 'http://x',
      fetch: () =>
        Promise.resolve(
          new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
        ),
    });
    await expect(collect(client)).rejects.toMatchObject({
      kind: 'rate_limited',
      opts: { status: 429, retryAfterMs: 2000 },
    });
  });

  it('maps other HTTP errors, network errors and garbage chunks', async () => {
    const http = new GroqClient({
      apiKey: 'k',
      baseUrl: 'http://x',
      fetch: () => Promise.resolve(new Response('', { status: 503 })),
    });
    await expect(collect(http)).rejects.toMatchObject({ kind: 'http', opts: { status: 503 } });

    const net = new GroqClient({
      apiKey: 'k',
      baseUrl: 'http://x',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(collect(net)).rejects.toMatchObject({ kind: 'network' });

    const junk = new GroqClient({
      apiKey: 'k',
      baseUrl: 'http://x',
      fetch: () => Promise.resolve(sse(['data: {not json\n\n'])),
    });
    await expect(collect(junk)).rejects.toMatchObject({ kind: 'bad_response' });

    const inStream = new GroqClient({
      apiKey: 'k',
      baseUrl: 'http://x',
      fetch: () =>
        Promise.resolve(sse([`data: ${JSON.stringify({ error: { message: 'overloaded' } })}\n\n`])),
    });
    await expect(collect(inStream)).rejects.toMatchObject({ kind: 'http' });
  });

  it('reports an abort as aborted, not as a network error', async () => {
    const ac = new AbortController();
    const client = new GroqClient({
      apiKey: 'k',
      baseUrl: 'http://x',
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    const p = collect(client, ac.signal);
    ac.abort();
    const err: unknown = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ kind: 'aborted' });
  });

  it('sends reasoning settings only when given (reasoning models)', async () => {
    const bodies: unknown[] = [];
    const client = new GroqClient({
      apiKey: 'k',
      baseUrl: 'http://x',
      fetch: (_url, init) => {
        bodies.push(JSON.parse(init.body as string));
        return Promise.resolve(sse(['data: [DONE]\n\n']));
      },
    });
    const drain = async (req: LlmRequest) => {
      const out: string[] = [];
      for await (const d of client.stream(req, new AbortController().signal)) out.push(d);
      return out;
    };
    await drain(REQ);
    await drain({
      ...REQ,
      model: 'openai/gpt-oss-20b',
      maxTokens: 512,
      reasoningEffort: 'low',
      includeReasoning: false,
    });
    expect(bodies[0]).not.toHaveProperty('reasoning_effort');
    expect(bodies[0]).not.toHaveProperty('include_reasoning');
    expect(bodies[1]).toMatchObject({
      model: 'openai/gpt-oss-20b',
      max_completion_tokens: 512,
      reasoning_effort: 'low',
      include_reasoning: false,
    });
  });

  it("puts the provider's error message in the error (e.g. unknown model)", async () => {
    const client = new GroqClient({
      apiKey: 'k',
      baseUrl: 'http://x',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                message:
                  'The model `llama-3.1-8b-instant` does not exist or you do not have access to it.',
                type: 'invalid_request_error',
                code: 'model_not_found',
              },
            }),
            { status: 404 },
          ),
        ),
    });
    await expect(collect(client)).rejects.toMatchObject({
      kind: 'http',
      opts: { status: 404 },
      message: expect.stringContaining('does not exist') as unknown,
    });
  });
});
