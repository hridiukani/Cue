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

export type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * How the judge model is asked. Stored with every graded run: a verdict from
 * low reasoning effort isn't guaranteed to match one from medium, so reports
 * and compare say when runs were graded with different settings.
 */
export interface JudgeSettings {
  /** Sent only to reasoning models (gpt-oss); other models ignore it. */
  reasoningEffort: ReasoningEffort;
  /** Counts hidden reasoning too; providers count this cap against tokens-per-minute limits. */
  maxCompletionTokens: number;
}

/**
 * What the judge used before settings were recorded per line (runs saved up to
 * 2026-11-19). Only for reading old files; new runs use the settings pinned in
 * config.ts (JUDGE_PINNED).
 */
export const LEGACY_JUDGE_SETTINGS: JudgeSettings = {
  reasoningEffort: 'medium',
  maxCompletionTokens: 1024,
};

export const judgeSettingsKey = (s: JudgeSettings): string =>
  `${s.reasoningEffort}/${String(s.maxCompletionTokens)}`;

export interface JudgeClient {
  readonly model: string;
  readonly settings: JudgeSettings;
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

// ------------------------------------------------------------------ rate limits

export type RateLimitKind =
  'requests per minute' | 'requests per day' | 'tokens per minute' | 'tokens per day' | 'unknown';

/** What a 429 said about which limit was hit, from its headers and body. */
export interface RateLimitInfo {
  kind: RateLimitKind;
  /** The provider's own message, with the organization id removed. */
  message: string | null;
  retryAfterMs: number | null;
  /**
   * Groq's x-ratelimit-* headers: "requests" is the per-day request limit and
   * "tokens" the per-minute token limit. A per-day TOKEN limit has no header;
   * only the message names it.
   */
  headers: {
    limitRequests: string | null;
    remainingRequests: string | null;
    resetRequests: string | null;
    limitTokens: string | null;
    remainingTokens: string | null;
    resetTokens: string | null;
  };
}

const ErrorBodySchema = z.object({
  error: z.object({ message: z.string() }).loose(),
});

const KIND_BY_CODE: Record<string, RateLimitKind> = {
  RPM: 'requests per minute',
  RPD: 'requests per day',
  TPM: 'tokens per minute',
  TPD: 'tokens per day',
};

/** "1m26.4s", "7.66s", "2h3m", "450ms" → ms (null if unreadable). */
export function parseDuration(text: string): number | null {
  const t = text.trim();
  let total = 0;
  let matched = '';
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    const n = Number(m[1]);
    const unit = m[2];
    total += unit === 'h' ? n * 3_600_000 : unit === 'm' ? n * 60_000 : unit === 's' ? n * 1000 : n;
    matched += m[0];
  }
  return matched.length > 0 && matched === t ? Math.round(total) : null;
}

export function parseRateLimit(headers: Headers, bodyText: string): RateLimitInfo {
  let message: string | null = null;
  try {
    const body = ErrorBodySchema.safeParse(JSON.parse(bodyText));
    if (body.success) message = body.data.error.message;
  } catch {
    // Not JSON: go by the headers alone.
  }
  // Never keep account identifiers in result files or logs.
  message = message?.replace(/\borg_[A-Za-z0-9]+/g, 'org_…').slice(0, 400) ?? null;
  const h = (name: string) => headers.get(name);
  const info: RateLimitInfo['headers'] = {
    limitRequests: h('x-ratelimit-limit-requests'),
    remainingRequests: h('x-ratelimit-remaining-requests'),
    resetRequests: h('x-ratelimit-reset-requests'),
    limitTokens: h('x-ratelimit-limit-tokens'),
    remainingTokens: h('x-ratelimit-remaining-tokens'),
    resetTokens: h('x-ratelimit-reset-tokens'),
  };
  // The message names the limit, e.g. "... on tokens per day (TPD): Limit 200000, Used ...".
  const code = message ? /\((RPM|RPD|TPM|TPD)\)/.exec(message)?.[1] : undefined;
  let kind: RateLimitKind = code ? (KIND_BY_CODE[code] ?? 'unknown') : 'unknown';
  if (kind === 'unknown') {
    if (info.remainingRequests === '0') kind = 'requests per day';
    else if (info.remainingTokens === '0') kind = 'tokens per minute';
  }
  const seconds = Number(h('retry-after'));
  const fromHeader = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  const tryAgain = message ? /try again in ([\dhms.]+?)\.?(?:\s|$)/i.exec(message)?.[1] : undefined;
  const fromMessage = tryAgain ? parseDuration(tryAgain) : null;
  return {
    kind,
    message,
    // The later of the two: retrying before the provider says so only burns a retry.
    retryAfterMs:
      fromHeader === null && fromMessage === null
        ? null
        : Math.max(fromHeader ?? 0, fromMessage ?? 0),
    headers: info,
  };
}

export class JudgeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs: number | null,
    readonly rateLimit: RateLimitInfo | null = null,
  ) {
    super(message);
    this.name = 'JudgeHttpError';
  }
}

/** Groq (OpenAI-compatible) JSON-mode completion, not streamed: the judge's speed doesn't matter. */
export class GroqJudgeClient implements JudgeClient {
  readonly settings: JudgeSettings;
  constructor(
    readonly model: string,
    private readonly opts: {
      apiKey: string;
      baseUrl: string;
      fetch?: FetchFn;
      settings: JudgeSettings;
    },
  ) {
    this.settings = opts.settings;
  }

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
        max_completion_tokens: this.settings.maxCompletionTokens,
        response_format: { type: 'json_object' },
        ...(/(^|\/)gpt-oss/i.test(this.model)
          ? { reasoning_effort: this.settings.reasoningEffort, include_reasoning: false }
          : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      if (res.status === 429) {
        const info = parseRateLimit(res.headers, await res.text().catch(() => ''));
        throw new JudgeHttpError(429, `judge HTTP 429 (${info.kind})`, info.retryAfterMs, info);
      }
      throw new JudgeHttpError(res.status, `judge HTTP ${String(res.status)}`, null);
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
