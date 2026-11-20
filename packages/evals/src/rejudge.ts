import { randomUUID } from 'node:crypto';
import { rubricHash } from './cases';
import type { DeterministicResult } from './checks';
import type { JudgeSettings, RateLimitInfo } from './judge';
import type { ResolvedCase } from './resolve';
import { type RunFile, type RunMeta, withFreshSummaries } from './results';
import { type GradeContext, gradeLine } from './runner';
import { isUngraded, scoreRun } from './scoring';
import type { RunRecord } from './summary';

/**
 * `pnpm eval rejudge <file>`: grade the UNGRADED runs of a saved eval run
 * from the lines the model already wrote. Nothing is regenerated, so the
 * model's lines, latency and cost stay exactly as measured; only the judge's
 * verdicts are filled in. The result is a new file (the original is kept).
 *
 * A case whose rubric, playbook or window changed since the run is skipped:
 * grading it now would mix two rubrics in one run.
 */

/**
 * Rejudge runs locally and can afford to wait: a retry-after of up to 15
 * minutes is waited out (`pnpm eval` stops at JUDGE_PINNED.maxWaitS); a longer
 * one means the daily quota is spent.
 */
export const REJUDGE_MAX_WAIT_S = 900;

export interface RejudgeInfo {
  /** The file and run this one was re-graded from. */
  of: { file: string; runId: string };
  at: string;
  judgeSettings: JudgeSettings;
  regraded: number;
  stillUngraded: number;
  skipped: { caseId: string; reason: string }[];
  git: RunMeta['git'];
}

export type ResolveById = (
  caseId: string,
) => Promise<{ ok: true; resolved: ResolvedCase } | { ok: false; reason: string }>;

export interface RejudgeDeps extends GradeContext {
  createdAt: () => string;
  git: RunMeta['git'];
  onGraded?: (caseId: string, run: RunRecord) => void;
}

const addUsage = (a: RunRecord['judgeUsage'], b: RunRecord['judgeUsage']) =>
  a && b
    ? {
        promptTokens: a.promptTokens + b.promptTokens,
        completionTokens: a.completionTokens + b.completionTokens,
        reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
      }
    : (a ?? b);

export async function rejudgeRun(
  source: { file: string; run: RunFile },
  resolveById: ResolveById,
  deps: RejudgeDeps,
): Promise<{ run: RunFile; info: RejudgeInfo; lastRateLimit: RateLimitInfo | null }> {
  const skipped: RejudgeInfo['skipped'] = [];
  let regraded = 0;
  let lastRateLimit: RateLimitInfo | null = null;
  const cases: RunFile['cases'] = [];
  for (const c of source.run.cases) {
    const pending = c.runs.filter((r) => isUngraded(r));
    if (pending.length === 0) {
      cases.push(c);
      continue;
    }
    const r = await resolveById(c.id);
    const reason = !r.ok
      ? r.reason
      : rubricHash(r.resolved.case) !== c.rubricHash
        ? "its rubric, playbook or window changed since this run, so it can't be graded against the rubric the run used"
        : null;
    if (reason !== null || !r.ok) {
      skipped.push({ caseId: c.id, reason: reason ?? 'unresolved' });
      cases.push(c);
      continue;
    }
    const runs: RunRecord[] = [];
    for (const run of c.runs) {
      if (!isUngraded(run)) {
        runs.push(run);
        continue;
      }
      const graded = await gradeLine(r.resolved, run.shown, deps);
      if (graded.rateLimit) lastRateLimit = graded.rateLimit;
      const checks: DeterministicResult = {
        shown: run.shown,
        words: run.words,
        checks: run.checks,
        pass: run.checks.every((x) => x.pass),
      };
      const score = scoreRun({
        checks,
        verdict: graded.verdict,
        error: null,
        judgeError: graded.error,
      });
      const next: RunRecord = {
        ...run,
        verdict: graded.verdict,
        judgeError: graded.error,
        pass: score.pass,
        score: score.score,
        reasons: score.reasons,
        judgeUsage: addUsage(run.judgeUsage, graded.usage),
        judgeSettings: graded.settings,
        judgeRateLimit: graded.error ? graded.rateLimit : null,
        rejudged: true,
      };
      if (graded.verdict) regraded++;
      runs.push(next);
      deps.onGraded?.(c.id, next);
    }
    cases.push({ ...c, runs });
  }
  const stillUngraded = cases.flatMap((c) => c.runs).filter((r) => isUngraded(r)).length;
  const info: RejudgeInfo = {
    of: { file: source.file, runId: source.run.meta.runId },
    at: deps.createdAt(),
    judgeSettings: deps.judge.settings,
    regraded,
    stillUngraded,
    skipped,
    git: deps.git,
  };
  const run = withFreshSummaries({
    ...source.run,
    meta: {
      ...source.run.meta,
      // A new run id and time (so it sorts as the newest file); the generation's
      // git commit, model and prompt version stay as they were.
      runId: randomUUID(),
      createdAt: info.at,
      rejudge: info,
    },
    cases,
  });
  return { run, info, lastRateLimit };
}
