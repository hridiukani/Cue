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
  parseVerdict,
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
 * latency is recorded. Everything else that fails is recorded as a failed run.
 */

export const FIRST_TOKEN_DEADLINE_MS = 1500; // production's drop deadline
const MAX_RAW_CHARS = 2000; // stop a runaway answer: it fails the length check anyway

export interface RunnerOptions {
  model: string;
  promptVersion: string;
  runsPerCase: number;
  concurrency: number;
  totalTimeoutMs?: number;
  maxRetries?: number;
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
  const maxRetries = opts.maxRetries ?? 3;
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
        await deps.sleep(Math.min(wait, 30_000));
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      return { raw, firstTokenMs: null, usage, error: `model: ${message}` };
    }
  }
}

async function judge(
  rc: ResolvedCase,
  shown: string,
  opts: RunnerOptions,
  deps: RunnerDeps,
): Promise<{
  verdict: RunRecord['verdict'];
  error: string | null;
  usage: TokenUsage | null;
}> {
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
  const usage = (): TokenUsage | null => (billed ? { ...total } : null);
  let lastError = 'judge failed';
  const maxRetries = opts.maxRetries ?? 3;
  // One extra try for an unreadable verdict; rate limits wait and retry.
  for (let attempt = 0, badVerdicts = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await deps.judge.complete(messages);
      if (res.usage) {
        billed = true;
        total.promptTokens += res.usage.promptTokens;
        total.completionTokens += res.usage.completionTokens;
        total.reasoningTokens += res.usage.reasoningTokens ?? 0;
      }
      const parsed = parseVerdict(res.text, rc.case.rubric.must.length, mustNot.length);
      if (parsed.ok) return { verdict: parsed.verdict, error: null, usage: usage() };
      lastError = parsed.error;
      if (++badVerdicts > 1) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const wait = retryDelay(err);
      if (wait === null) break;
      await deps.sleep(Math.min(wait, 30_000));
    }
  }
  return { verdict: null, error: lastError, usage: usage() };
}

async function runOnce(
  rc: ResolvedCase,
  attempt: number,
  opts: RunnerOptions,
  deps: RunnerDeps,
): Promise<RunRecord> {
  const gen = await generate(rc, opts, deps);
  const checks = gen.error ? null : runDeterministicChecks(gen.raw, rc.case.rubric.bannedPhrases);
  const graded =
    checks && checks.shown !== ''
      ? await judge(rc, checks.shown, opts, deps)
      : { verdict: null, error: null, usage: null };
  const score = scoreRun({
    checks,
    verdict: graded.verdict,
    error: gen.error ?? (graded.error ? `judge: ${graded.error}` : null),
  });
  return {
    attempt,
    raw: gen.raw,
    shown: checks?.shown ?? '',
    words: checks?.words ?? 0,
    checks: checks?.checks ?? [],
    verdict: graded.verdict,
    judgeError: graded.error,
    error: gen.error,
    pass: score.pass,
    score: score.score,
    reasons: score.reasons,
    firstTokenMs: gen.firstTokenMs,
    overDeadline: gen.firstTokenMs !== null && gen.firstTokenMs > FIRST_TOKEN_DEADLINE_MS,
    usage: gen.usage,
    judgeUsage: graded.usage,
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
  let next = 0;
  const worker = async () => {
    for (;;) {
      const task = tasks[next++];
      if (!task) return;
      const rc = cases[task.index];
      const record = records[task.index];
      if (!rc || !record) return;
      const run = await runOnce(rc, task.attempt, opts, deps);
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
