import { z } from 'zod';
import type { ChatMessage } from './prompt';

/** Any streaming chat model. Groq today; a fake in tests. */
export interface LlmClient {
  readonly name: string;
  /** Yields text deltas as they arrive. Throws LlmError. Stops when `signal` aborts. */
  stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<string>;
}

export interface LlmRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  stop?: string[];
  /** Reasoning models only (e.g. openai/gpt-oss-*): how much hidden "thinking" to do. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Reasoning models only: false keeps the hidden reasoning out of the stream. */
  includeReasoning?: boolean;
  /** Called once with the provider's token counts, if it reports them (for cost). */
  onUsage?: (usage: TokenUsage) => void;
}

/** Billed tokens for one request. Reasoning tokens are part of completionTokens. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number | null;
}

export type LlmErrorKind = 'rate_limited' | 'http' | 'network' | 'bad_response' | 'aborted';

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly opts: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const ChunkSchema = z
  .object({
    choices: z
      .array(
        z.object({ delta: z.object({ content: z.string().nullish() }).loose().nullish() }).loose(),
      )
      .default([]),
  })
  .loose();
// Groq sends token counts on the final chunk, as `usage` and as `x_groq.usage`.
const UsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    completion_tokens_details: z
      .object({ reasoning_tokens: z.number().int().nonnegative().nullish() })
      .loose()
      .nullish(),
  })
  .loose();
const UsageChunkSchema = z
  .object({
    usage: UsageSchema.nullish(),
    x_groq: z.object({ usage: UsageSchema.nullish() }).loose().nullish(),
  })
  .loose();

const StreamErrorSchema = z.object({ error: z.object({ message: z.string() }).loose() }).loose();

const DEFAULT_RETRY_AFTER_MS = 10_000;

/**
 * Groq's OpenAI-compatible chat completions API, streamed as server-sent
 * events ("data: {json}" lines, ending with "data: [DONE]"). Raw fetch, no
 * SDK: we need precise control over cancellation and timing.
 */
export class GroqClient implements LlmClient {
  readonly name = 'groq';

  constructor(private readonly opts: { apiKey: string; baseUrl: string; fetch?: FetchFn }) {}

  async *stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<string> {
    const fetchFn = this.opts.fetch ?? ((url, init) => fetch(url, init));
    let res: Response;
    try {
      res = await fetchFn(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
          n: 1,
          max_completion_tokens: req.maxTokens,
          temperature: req.temperature,
          ...(req.stop ? { stop: req.stop } : {}),
          ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
          ...(req.includeReasoning === undefined
            ? {}
            : { include_reasoning: req.includeReasoning }),
        }),
      });
    } catch (err) {
      throw toLlmError(err, signal);
    }

    if (!res.ok) {
      if (res.status === 429) {
        const seconds = Number(res.headers.get('retry-after'));
        throw new LlmError('rate_limited', 'rate limited', {
          status: 429,
          retryAfterMs:
            Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS,
        });
      }
      // Include the provider's own message (e.g. "model ... does not exist") so logs say why.
      throw new LlmError('http', `HTTP ${String(res.status)}${await providerMessage(res)}`, {
        status: res.status,
      });
    }
    if (!res.body) throw new LlmError('bad_response', 'response has no body');

    // Node types the body loosely; fetch response bodies are byte streams.
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          throw toLlmError(err, signal);
        }
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        // SSE events can be split across network chunks: only handle complete lines.
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line.startsWith('data:')) continue; // blank lines, ": keep-alive" comments, event names
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          const { delta, usage } = parseChunk(data);
          if (usage && req.onUsage) req.onUsage(usage);
          if (delta) yield delta;
        }
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }
}

function parseChunk(data: string): { delta: string | null; usage: TokenUsage | null } {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw new LlmError('bad_response', 'stream chunk is not JSON');
  }
  const err = StreamErrorSchema.safeParse(json);
  if (err.success) throw new LlmError('http', `provider error: ${err.data.error.message}`);
  const parsed = ChunkSchema.safeParse(json);
  if (!parsed.success) throw new LlmError('bad_response', 'unexpected stream chunk');
  const content = parsed.data.choices[0]?.delta?.content;
  const delta = content === undefined || content === null || content === '' ? null : content;
  const u = UsageChunkSchema.safeParse(json);
  const raw = u.success ? (u.data.usage ?? u.data.x_groq?.usage ?? null) : null;
  const usage: TokenUsage | null = raw
    ? {
        promptTokens: raw.prompt_tokens,
        completionTokens: raw.completion_tokens,
        reasoningTokens: raw.completion_tokens_details?.reasoning_tokens ?? null,
      }
    : null;
  return { delta, usage };
}

/** ": <message>" from an OpenAI-style error body, or '' if there isn't a readable one. */
async function providerMessage(res: Response): Promise<string> {
  try {
    const parsed = StreamErrorSchema.safeParse(JSON.parse(await res.text()));
    return parsed.success ? `: ${parsed.data.error.message.slice(0, 200)}` : '';
  } catch {
    return '';
  }
}

function toLlmError(err: unknown, signal: AbortSignal): LlmError {
  if (err instanceof LlmError) return err;
  if (signal.aborted) return new LlmError('aborted', 'aborted');
  return new LlmError('network', err instanceof Error ? err.message : String(err));
}
