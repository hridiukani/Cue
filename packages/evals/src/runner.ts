import {
  buildSuggestionMessages,
  LlmError,
  type LlmClient,
  modelRequestSettings,
  SUGGESTION_SAMPLING,
  type TokenUsage,
} from '@cue/suggest';
import { rubricHash } from './cases';
import { runDeterministicChecks } from './checks';
import {
  allMustNot,
  buildJudgeMessages,
  type JudgeClient,
  JudgeHttpError,
  type JudgeSettings,
  parseVerdict,
  type RateLimitInfo,
} from './judge';
import type { ResolvedCase } from './resolve';
import { scoreRun } from './scoring';
import type { CaseRecord, RunRecord } from './summary';

/**
 * Runs every case N times against the model under test, exactly as production
 * would call it (same prompt builder, sampling and per-model settings), then
 * grades each line with the judge.
 *
 * Unlike production, a 429 is retried here after the provider's retry-after:
 * an eval needs an answer for every case, and only the successful attempt's
 * latency is recorded. A model failure is recorded as a failed run; a judge
 * failure leaves the run UNGRADED (see scoring.ts), to grade later with
 * `pnpm eval rejudge`.
 */

export const FIRST_TOKEN_DEADLINE_MS = 1500; // production's drop deadline
const MAX_RAW_CHARS = 2000; // stop a runaway answer: it fails the length check anyway

export interface RunnerOptions {
  model: string;
  promptVersion: string;
  runsPerCase: number;
  concurrency: number;
  /**
   * Judge calls in flight at once (default 1). Lower than `concurrency`: judge
   * calls use ~1,500 tokens each and providers limit tokens per minute
   * (8,000/min for openai/gpt-oss-120b on our Groq account, 2026-11-18).
   */
  judgeConcurrency?: number;
  /** Minimum time between the starts of two judge calls (default 0: no pacing). */
  judgeMinIntervalMs?: number;
  totalTimeoutMs?: number;
  /** Rate-limit retries per request (default 8). Evals can afford to wait. */
  maxRetries?: number;
  /**
   * The longest provider wait (retry-after) worth sitting through, default
   * 2 minutes. A longer one means a quota that refills slowly (e.g. tokens
   * per day) is spent: the remaining judge calls are left ungraded at once
   * rather than each waiting it out, and `pnpm eval rejudge` grades them later.
   */
  maxWaitMs?: number;
}

export const DEFAULT_MAX_RETRIES = 8;
export const DEFAULT_MAX_WAIT_MS = 120_000;

/**
 * How long to wait before retry number `attempt` (0-based): the provider's
 * retry-after in full (never shortened: retrying early only burns a retry),
 * or an exponential backoff (2 s, 4 s, 8 s … capped at 60 s) if that's longer.
 *
 * Until 2026-11-19 the provider's wait was capped at 60 s too, so a "try again
 * in 7 minutes" was retried after 60 s eight times and every retry was wasted.
 */
export function backoffMs(attempt: number, providerWaitMs: number): number {
  return Math.max(providerWaitMs, Math.min(60_000, 2000 * 2 ** attempt));
}

/** At most `size` holders at once; the rest wait in order. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly size: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export class JudgeExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeExhaustedError';
  }
}

/**
 * Every judge call goes through one gate:
 * - at most `concurrency` calls in flight;
 * - at least `minIntervalMs` between call starts (pacing under a tokens-per-minute limit);
 * - after a 429, NO judge call starts until the provider's retry-after has passed;
 * - once the provider asks for a wait longer than the allowed maximum, the
 *   gate is "exhausted" and every later call fails at once with the reason.
 */
export class JudgeGate {
  private readonly slots: Semaphore;
  private lastStart = Number.NEGATIVE_INFINITY;
  private pausedUntil = Number.NEGATIVE_INFINITY;
  exhausted: string | null = null;
  constructor(
    concurrency: number,
    private readonly minIntervalMs: number,
    private readonly clock: { now: () => number; sleep: (ms: number) => Promise<void> },
  ) {
    this.slots = new Semaphore(Math.max(1, concurrency));
  }

  /** The provider said: no calls for `ms`. */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + ms);
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    return this.slots.run(async () => {
      for (;;) {
        if (this.exhausted) throw new JudgeExhaustedError(this.exhausted);
        const wait =
          Math.max(this.pausedUntil, this.lastStart + this.minIntervalMs) - this.clock.now();
        if (wait <= 0) break;
        await this.clock.sleep(wait);
      }
      this.lastStart = this.clock.now();
      return fn();
    });
  }
}

export interface RunnerDeps {
  llm: LlmClient;
  judge: JudgeClient;
  /** Monotonic ms (performance.now() in the CLI). */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** An AbortSignal that fires after ms (AbortSignal.timeout in the CLI). */
  timeout: (ms: number) => AbortSignal;
  onRunDone?: (caseId: string, run: RunRecord) => void;
  /** A request was rate limited and will be retried after `waitMs` (or not, if `gaveUp`). */
  onRateLimited?: (
    who: 'model' | 'judge',
    waitMs: number,
    info: RateLimitInfo | null,
    gaveUp: boolean,
  ) => void;
}

interface Generation {
  raw: string;
  firstTokenMs: number | null;
  usage: TokenUsage | null;
  error: string | null;
}

const retryDelay = (err: unknown): number | null => {
  if (err instanceof LlmError && err.kind === 'rate_limited')
    return err.opts.retryAfterMs ?? 10_000;
  if (err instanceof JudgeHttpError && err.status === 429) return err.retryAfterMs ?? 10_000;
  return null;
};

const minutes = (ms: number) =>
  ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${String(Math.round(ms / 1000))} s`;

async function generate(
  rc: ResolvedCase,
  opts: RunnerOptions,
  deps: RunnerDeps,
): Promise<Generation> {
  const { messages } = buildSuggestionMessages({
    playbook: rc.playbook,
    history: rc.window,
    promptVersion: opts.promptVersion,
  });
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxWait = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    let usage: TokenUsage | null = null;
    let raw = '';
    let firstTokenMs: number | null = null;
    const sentAt = deps.now();
    try {
      for await (const delta of deps.llm.stream(
        {
          model: opts.model,
          messages,
          temperature: SUGGESTION_SAMPLING.temperature,
          ...modelRequestSettings(opts.model, SUGGESTION_SAMPLING.maxTokens),
          onUsage: (u) => {
            usage = u;
          },
        },
        deps.timeout(opts.totalTimeoutMs ?? 15_000),
      )) {
        firstTokenMs ??= deps.now() - sentAt;
        raw += delta;
        if (raw.length > MAX_RAW_CHARS) break;
      }
      return { raw, firstTokenMs, usage, error: null };
    } catch (err) {
      const wait = retryDelay(err);
      if (wait !== null && attempt < maxRetries) {
        const ms = backoffMs(attempt, wait);
        const gaveUp = ms > maxWait;
        deps.onRateLimited?.('model', ms, null, gaveUp);
        if (!gaveUp) {
          await deps.sleep(ms);
          continue;
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      return { raw, firstTokenMs: null, usage, error: `model: ${message}` };
    }
  }
}

export interface Graded {
  verdict: RunRecord['verdict'];
  error: string | null;
  usage: TokenUsage | null;
  settings: JudgeSettings;
  /** The last 429 seen while grading (null if none). */
  rateLimit: RateLimitInfo | null;
}

export interface GradeContext {
  judge: JudgeClient;
  gate: JudgeGate;
  maxRetries?: number;
  maxWaitMs?: number;
  onRateLimited?: RunnerDeps['onRateLimited'];
}

/** Grade one shown line against its case's rubric. Shared by `pnpm eval` and `pnpm eval rejudge`. */
export async function gradeLine(
  rc: ResolvedCase,
  shown: string,
  ctx: GradeContext,
): Promise<Graded> {
  const mustNot = allMustNot(rc.case.rubric.mustNot);
  const messages = buildJudgeMessages({
    window: rc.window,
    playbookText: rc.playbookText,
    suggestion: shown,
    must: rc.case.rubric.must,
    mustNot: rc.case.rubric.mustNot,
  });
  // Every judge call is billed, including retries: add them all up.
  const total = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };
  let billed = false;
  let rateLimit: RateLimitInfo | null = null;
  const done = (verdict: Graded['verdict'], error: string | null): Graded => ({
    verdict,
    error,
    usage: billed ? { ...total } : null,
    settings: ctx.judge.settings,
    rateLimit,
  });
  let lastError = 'judge failed';
  const maxRetries = ctx.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxWait = ctx.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  // One extra try for an unreadable verdict; rate limits wait and retry.
  for (let attempt = 0, badVerdicts = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await ctx.gate.run(() => ctx.judge.complete(messages));
      if (res.usage) {
        billed = true;
        total.promptTokens += res.usage.promptTokens;
        total.completionTokens += res.usage.completionTokens;
        total.reasoningTokens += res.usage.reasoningTokens ?? 0;
      }
      const parsed = parseVerdict(res.text, rc.case.rubric.must.length, mustNot.length);
      if (parsed.ok) return done(parsed.verdict, null);
      lastError = parsed.error;
      if (++badVerdicts > 1) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (err instanceof JudgeHttpError && err.rateLimit) rateLimit = err.rateLimit;
      const wait = retryDelay(err);
      if (wait === null) break;
      const ms = backoffMs(attempt, wait);
      if (ms > maxWait) {
        ctx.onRateLimited?.('judge', ms, rateLimit, true);
        ctx.gate.exhausted ??= `${lastError}: the provider asked to wait ${minutes(ms)}, more than the ${minutes(maxWait)} allowed`;
        lastError = ctx.gate.exhausted;
        break;
      }
      if (attempt === maxRetries) break;
      ctx.onRateLimited?.('judge', ms, rateLimit, false);
      ctx.gate.pause(ms);
    }
  }
  return done(null, lastError);
}

async function runOnce(
  rc: ResolvedCase,
  attempt: number,
  opts: RunnerOptions,
  deps: RunnerDeps,
  gate: JudgeGate,
): Promise<RunRecord> {
  const gen = await generate(rc, opts, deps);
  const checks = gen.error ? null : runDeterministicChecks(gen.raw, rc.case.rubric.bannedPhrases);
  const graded =
    checks && checks.shown !== ''
      ? await gradeLine(rc, checks.shown, {
          judge: deps.judge,
          gate,
          maxRetries: opts.maxRetries,
          maxWaitMs: opts.maxWaitMs,
          onRateLimited: deps.onRateLimited,
        })
      : null;
  const score = scoreRun({
    checks,
    verdict: graded?.verdict ?? null,
    error: gen.error,
    judgeError: graded?.error ?? null,
  });
  return {
    attempt,
    raw: gen.raw,
    shown: checks?.shown ?? '',
    words: checks?.words ?? 0,
    checks: checks?.checks ?? [],
    verdict: graded?.verdict ?? null,
    judgeError: graded?.error ?? null,
    error: gen.error,
    pass: score.pass,
    score: score.score,
    reasons: score.reasons,
    firstTokenMs: gen.firstTokenMs,
    overDeadline: gen.firstTokenMs !== null && gen.firstTokenMs > FIRST_TOKEN_DEADLINE_MS,
    usage: gen.usage,
    judgeUsage: graded?.usage ?? null,
    judgeSettings: graded ? graded.settings : null,
    judgeRateLimit: graded?.error ? graded.rateLimit : null,
  };
}

/** Run all cases × runsPerCase with at most `concurrency` generations at once. */
export async function runCases(
  cases: readonly ResolvedCase[],
  opts: RunnerOptions,
  deps: RunnerDeps,
): Promise<CaseRecord[]> {
  if (!Number.isInteger(opts.runsPerCase) || opts.runsPerCase < 1) {
    throw new Error('runsPerCase must be a positive integer');
  }
  const records: CaseRecord[] = cases.map((rc) => ({
    id: rc.case.id,
    category: rc.case.category,
    dataset: rc.case.source.dataset,
    license: rc.case.source.license,
    rubricHash: rubricHash(rc.case),
    playbook: rc.case.playbook,
    status: rc.case.status,
    runs: [],
  }));
  // Attempt-major order: every case gets its first run before any gets its second.
  const tasks: { index: number; attempt: number }[] = [];
  for (let attempt = 1; attempt <= opts.runsPerCase; attempt++) {
    for (let index = 0; index < cases.length; index++) tasks.push({ index, attempt });
  }
  const gate = new JudgeGate(opts.judgeConcurrency ?? 1, opts.judgeMinIntervalMs ?? 0, deps);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const task = tasks[next++];
      if (!task) return;
      const rc = cases[task.index];
      const record = records[task.index];
      if (!rc || !record) return;
      const run = await runOnce(rc, task.attempt, opts, deps, gate);
      record.runs.push(run);
      deps.onRunDone?.(rc.case.id, run);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(opts.concurrency, tasks.length)) }, worker),
  );
  for (const r of records) r.runs.sort((a, b) => a.attempt - b.attempt);
  return records;
}
