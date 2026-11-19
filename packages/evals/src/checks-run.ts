import { type CheckId, type CheckResult, runDeterministicChecks } from './checks';
import { percentile } from './latency';
import type { ResolvedCase } from './resolve';
import {
  FIRST_TOKEN_DEADLINE_MS,
  generate,
  type GenerateDeps,
  type GenerateOptions,
} from './runner';

/**
 * `pnpm eval checks`: generate lines with the production prompt and score them
 * with the deterministic checks only (length, one line, preamble, placeholders,
 * banned phrases). No judge, so it spends none of the judge's daily token quota
 * and can't fail because the judge was rate limited. This is what CI runs on
 * every pull request; the judged smoke run is a manual workflow.
 *
 * It answers "does the pipeline still produce sayable lines?", not "are they
 * good?". Quality needs the judge (`pnpm eval`).
 */

export interface CheckedLine {
  caseId: string;
  attempt: number;
  shown: string;
  /** Words in the model's own line, before production's 20-word cut. */
  words: number;
  checks: CheckResult[];
  /** The model under test failed: the rep would get nothing, so the line fails. */
  error: string | null;
  pass: boolean;
  firstTokenMs: number | null;
}

export interface ChecksSummary {
  lines: number;
  passes: number;
  passRate: number;
  modelErrors: number;
  /** How many lines failed each check (a line can fail several). */
  failedChecks: Partial<Record<CheckId, number>>;
  overWords: { count: number; max: number };
  firstTokenMs: { p50: number; p95: number; overDeadline: number } | null;
}

export interface ChecksOptions extends GenerateOptions {
  runsPerCase: number;
  concurrency: number;
}

export async function runChecksOnly(
  cases: readonly ResolvedCase[],
  opts: ChecksOptions,
  deps: GenerateDeps & { onLineDone?: (line: CheckedLine) => void },
): Promise<CheckedLine[]> {
  if (!Number.isInteger(opts.runsPerCase) || opts.runsPerCase < 1) {
    throw new Error('runsPerCase must be a positive integer');
  }
  const tasks: { rc: ResolvedCase; attempt: number }[] = [];
  for (let attempt = 1; attempt <= opts.runsPerCase; attempt++) {
    for (const rc of cases) tasks.push({ rc, attempt });
  }
  const lines: CheckedLine[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const task = tasks[next++];
      if (!task) return;
      const gen = await generate(task.rc, opts, deps);
      const det = gen.error
        ? null
        : runDeterministicChecks(gen.raw, task.rc.case.rubric.bannedPhrases);
      const line: CheckedLine = {
        caseId: task.rc.case.id,
        attempt: task.attempt,
        shown: det?.shown ?? '',
        words: det?.words ?? 0,
        checks: det?.checks ?? [],
        error: gen.error,
        pass: gen.error === null && det?.pass === true,
        firstTokenMs: gen.firstTokenMs,
      };
      lines.push(line);
      deps.onLineDone?.(line);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(opts.concurrency, tasks.length)) }, worker),
  );
  return lines.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.attempt - b.attempt);
}

export function summarizeChecks(lines: readonly CheckedLine[]): ChecksSummary {
  const failedChecks: Partial<Record<CheckId, number>> = {};
  for (const l of lines) {
    for (const c of l.checks) if (!c.pass) failedChecks[c.id] = (failedChecks[c.id] ?? 0) + 1;
  }
  const over = lines.filter((l) => l.checks.some((c) => c.id === 'max_words' && !c.pass));
  const firsts = lines
    .map((l) => l.firstTokenMs)
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  const passes = lines.filter((l) => l.pass).length;
  return {
    lines: lines.length,
    passes,
    passRate: lines.length === 0 ? 0 : passes / lines.length,
    modelErrors: lines.filter((l) => l.error !== null).length,
    failedChecks,
    overWords: { count: over.length, max: Math.max(0, ...over.map((l) => l.words)) },
    firstTokenMs:
      firsts.length === 0
        ? null
        : {
            p50: percentile(firsts, 50),
            p95: percentile(firsts, 95),
            overDeadline: firsts.filter((x) => x > FIRST_TOKEN_DEADLINE_MS).length,
          },
  };
}

/** Why the run should fail (empty = it passes). */
export function checksProblems(s: ChecksSummary, minPassRate: number | null): string[] {
  if (minPassRate === null || s.passRate >= minPassRate) return [];
  return [
    `Deterministic pass rate ${pct(s.passRate)} (${String(s.passes)} of ${String(s.lines)} lines) is below the threshold of ${pct(minPassRate)}.`,
  ];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function formatChecks(
  s: ChecksSummary,
  lines: readonly CheckedLine[],
  meta: { model: string; promptVersion: string },
): string {
  const failed = Object.entries(s.failedChecks)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, n]) => `${id} ×${String(n)}`);
  const out = [
    `Deterministic checks only (no judge): ${meta.model}, prompt ${meta.promptVersion}`,
    `Pass rate      ${pct(s.passRate)} (${String(s.passes)} of ${String(s.lines)} lines pass every check)`,
    `Model errors   ${String(s.modelErrors)}`,
    `Failed checks  ${failed.length > 0 ? failed.join(', ') : 'none'}`,
    `Over 20 words  ${String(s.overWords.count)}${s.overWords.count > 0 ? ` (longest ${String(s.overWords.max)})` : ''}`,
    s.firstTokenMs
      ? `First token    p50 ${String(Math.round(s.firstTokenMs.p50))} ms · p95 ${String(Math.round(s.firstTokenMs.p95))} ms · over the 1.5 s deadline: ${String(s.firstTokenMs.overDeadline)} (model time, not end-to-end)`
      : 'First token    –',
  ];
  const failing = lines.filter((l) => !l.pass);
  if (failing.length > 0) {
    out.push('', 'Failing lines:');
    for (const l of failing) {
      const why =
        l.error ??
        l.checks
          .filter((c) => !c.pass)
          .map((c) => c.detail ?? c.id)
          .join('; ');
      out.push(`  ${l.caseId} #${String(l.attempt)}: ${why}`);
    }
  }
  return out.join('\n');
}
