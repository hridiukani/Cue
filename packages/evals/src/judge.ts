import type { ChatMessage, TokenUsage, WindowUtterance } from '@cue/suggest';
import { z } from 'zod';

/**
 * LLM-as-judge: a DIFFERENT model from the one under test grades the shown
 * line against the case's rubric and returns a short rationale. Changing the
 * judge prompt means bumping JUDGE_VERSION (it's stored with every run, and
 * compare warns when two runs used different judges).
 */
export const JUDGE_VERSION = 'judge-v1';
export const PASS_MIN_SCORE = 4;

/** Applied to every case, on top of the case's own mustNot list. */
export const STANDARD_MUST_NOT = [
  'Invents product features, prices, numbers, customers or facts that are not in the playbook or the conversation.',
  'Argues with, corrects, contradicts or talks down to the prospect.',
  'Is something a rep could not say out loud on a live call (meta-commentary, instructions to the rep, several options).',
] as const;

export const JUDGE_SYSTEM_PROMPT = `You grade lines suggested to a sales rep during a live call.
A coach suggested ONE next line for the rep to say right after the prospect's last line.
Grade only that line, against the rubric. Be strict and consistent.

Score 1-5:
5 = excellent: does everything the rubric asks, natural, specific, ready to say verbatim.
4 = good: meets the rubric with only minor weaknesses.
3 = acceptable but weak: generic, or misses part of the rubric.
2 = poor: misses the point of the moment.
1 = harmful or unusable: breaks a "must not" rule, or makes things worse.
Any violated "must not" item caps the score at 2.

Reply with JSON only, exactly this shape:
{"must":[{"id":"M1","met":true}],"mustNot":[{"id":"N1","violated":false}],"score":4,"rationale":"one or two short sentences"}
Include every M and N id from the rubric, in order. Keep the rationale under 40 words.`;

export interface JudgeInput {
  window: readonly WindowUtterance[];
  playbookText: string | null;
  suggestion: string;
  must: readonly string[];
  mustNot: readonly string[];
}

/** Standard rules first, then the case's own, numbered N1.. */
export function allMustNot(caseMustNot: readonly string[]): string[] {
  return [...STANDARD_MUST_NOT, ...caseMustNot];
}

export function buildJudgeMessages(input: JudgeInput): ChatMessage[] {
  const transcript = input.window
    .map((u) => `${u.speaker === 'rep' ? 'Rep' : 'Prospect'}: ${u.text}`)
    .join('\n');
  const mustNot = allMustNot(input.mustNot);
  const user = [
    `Playbook:\n${input.playbookText ?? '(none: the coach had no product playbook)'}`,
    `Conversation (most recent last):\n${transcript}`,
    `Suggested next line for the rep:\n<<<${input.suggestion}>>>`,
    `Rubric. The line MUST:\n${input.must.map((m, i) => `M${String(i + 1)}. ${m}`).join('\n')}`,
    `The line must NOT:\n${mustNot.map((m, i) => `N${String(i + 1)}. ${m}`).join('\n')}`,
  ].join('\n\n');
  return [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

const VerdictSchema = z.object({
  must: z.array(z.object({ id: z.string(), met: z.boolean() })),
  mustNot: z.array(z.object({ id: z.string(), violated: z.boolean() })),
  score: z.number().int().min(1).max(5),
  rationale: z.string().trim().min(1),
});

export interface JudgeVerdict {
  /** Same order as the rubric's must list. */
  mustMet: boolean[];
  /** Same order as allMustNot(case.mustNot). */
  mustNotViolated: boolean[];
  score: number;
  rationale: string;
}

export type ParseVerdictResult = { ok: true; verdict: JudgeVerdict } | { ok: false; error: string };

/**
 * Validate the judge's JSON against the rubric it was given. Anything off
 * (bad JSON, missing or extra ids, out-of-range score) is an error rather than
 * a guess: a silently misread verdict would corrupt the pass rate.
 */
export function parseVerdict(
  text: string,
  mustCount: number,
  mustNotCount: number,
): ParseVerdictResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'judge did not return JSON' };
  }
  const parsed = VerdictSchema.safeParse(json);
  if (!parsed.success)
    return {
      ok: false,
      error: `judge JSON has the wrong shape: ${parsed.error.issues[0]?.message ?? ''}`,
    };
  const v = parsed.data;
  const ids = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1)}`);
  const sameIds = (got: { id: string }[], want: string[]) =>
    got.length === want.length && got.every((g, i) => g.id.trim().toUpperCase() === want[i]);
  if (!sameIds(v.must, ids('M', mustCount))) {
    return { ok: false, error: `judge must ids don't match M1..M${String(mustCount)}` };
  }
  if (!sameIds(v.mustNot, ids('N', mustNotCount))) {
    return { ok: false, error: `judge mustNot ids don't match N1..N${String(mustNotCount)}` };
  }
  const mustNotViolated = v.mustNot.map((n) => n.violated);
  // Enforce the cap the prompt states, in case the judge ignored it.
  const score = mustNotViolated.some(Boolean) ? Math.min(v.score, 2) : v.score;
  return {
    ok: true,
    verdict: {
      mustMet: v.must.map((m) => m.met),
      mustNotViolated,
      score,
      rationale: v.rationale.slice(0, 300),
    },
  };
}

// ------------------------------------------------------------------ client

export interface JudgeClient {
  readonly model: string;
  complete(messages: ChatMessage[]): Promise<{ text: string; usage: TokenUsage | null }>;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const CompletionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable() }).loose() }).loose())
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
      completion_tokens_details: z
        .object({ reasoning_tokens: z.number().int().nonnegative().nullish() })
        .loose()
        .nullish(),
    })
    .loose()
    .nullish(),
});

export class JudgeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = 'JudgeHttpError';
  }
}

/** Groq (OpenAI-compatible) JSON-mode completion, not streamed: the judge's speed doesn't matter. */
export class GroqJudgeClient implements JudgeClient {
  constructor(
    readonly model: string,
    private readonly opts: { apiKey: string; baseUrl: string; fetch?: FetchFn },
  ) {}

  async complete(messages: ChatMessage[]): Promise<{ text: string; usage: TokenUsage | null }> {
    const fetchFn = this.opts.fetch ?? ((url, init) => fetch(url, init));
    const res = await fetchFn(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0,
        // Largest reply seen was 656 tokens; providers count this cap against rate limits.
        max_completion_tokens: 1024,
        response_format: { type: 'json_object' },
        ...(/(^|\/)gpt-oss/i.test(this.model)
          ? { reasoning_effort: 'medium', include_reasoning: false }
          : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const seconds = Number(res.headers.get('retry-after'));
      throw new JudgeHttpError(
        res.status,
        `judge HTTP ${String(res.status)}`,
        res.status === 429 && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
      );
    }
    const parsed = CompletionSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error('judge returned an unexpected response');
    const u = parsed.data.usage;
    return {
      text: parsed.data.choices[0]?.message.content ?? '',
      usage: u
        ? {
            promptTokens: u.prompt_tokens,
            completionTokens: u.completion_tokens,
            reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? null,
          }
        : null,
    };
  }
}
