import type { RunFile } from './results';
import { isUngraded } from './scoring';

/**
 * Diff two eval runs (A = before, B = after) case by case.
 *
 * - A case regresses when its pass rate drops by at least REGRESSION_PASS_DROP
 *   or its mean score drops by at least REGRESSION_SCORE_DROP. Improvements
 *   are the mirror image.
 * - A case whose rubric (or playbook or window) changed between the runs is
 *   "rubric_changed": its numbers aren't comparable, so it's never called a
 *   regression or an improvement.
 * - Settings that differ (model, prompt, judge, N, case file) are listed so a
 *   change in the judge isn't mistaken for a change in the prompt.
 *
 * With N runs per case, one flipped run moves a case's pass rate by 1/N, so
 * small N is noisy: flaky cases are shown so they can be discounted.
 */
export const REGRESSION_PASS_DROP = 0.25;
export const REGRESSION_SCORE_DROP = 0.5;
/** The overall pass rate dropping by this much (5 points) is a regression too. */
export const OVERALL_PASS_DROP = 0.05;

export type CaseDiffStatus =
  'regressed' | 'improved' | 'unchanged' | 'rubric_changed' | 'errored' | 'only_in_a' | 'only_in_b';

export interface CaseDiff {
  id: string;
  category: string;
  status: CaseDiffStatus;
  a: { passRate: number | null; meanScore: number | null; flaky: boolean } | null;
  b: { passRate: number | null; meanScore: number | null; flaky: boolean } | null;
  passRateDelta: number | null;
  scoreDelta: number | null;
}

export interface MetricDiff {
  a: number | null;
  b: number | null;
  delta: number | null;
}

export interface CompareResult {
  a: { file: string; meta: RunFile['meta'] };
  b: { file: string; meta: RunFile['meta'] };
  settingsChanged: string[];
  /**
   * Same model, prompt, judge, N and cases: every difference is run-to-run
   * noise, which with small N is large (one flipped run = 1/N).
   */
  sameSettings: boolean;
  metrics: {
    passRate: MetricDiff;
    meanScore: MetricDiff;
    firstTokenP50: MetricDiff;
    firstTokenP95: MetricDiff;
    costPer1000Usd: MetricDiff;
  };
  overallRegressed: boolean;
  cases: CaseDiff[];
  regressions: number;
  improvements: number;
}

const diff = (a: number | null, b: number | null): MetricDiff => ({
  a,
  b,
  delta: a !== null && b !== null ? b - a : null,
});

function settingsChanged(a: RunFile['meta'], b: RunFile['meta']): string[] {
  const out: string[] = [];
  const check = (label: string, x: unknown, y: unknown) => {
    if (x !== y) out.push(`${label}: ${String(x)} → ${String(y)}`);
  };
  check('model', a.model, b.model);
  check('prompt version', a.promptVersion, b.promptVersion);
  check('judge model', a.judgeModel, b.judgeModel);
  check('judge version', a.judgeVersion, b.judgeVersion);
  check('runs per case', a.runsPerCase, b.runsPerCase);
  if (a.casesFile.sha256 !== b.casesFile.sha256) out.push('cases file changed');
  return out;
}

/** Runs of this case where the model failed or the run is ungraded (not a quality signal). */
function erroredRuns(c: RunFile['cases'][number]): number {
  return c.runs.filter((r) => r.error !== null || isUngraded(r)).length;
}

export function compareRuns(
  a: { file: string; run: RunFile },
  b: { file: string; run: RunFile },
): CompareResult {
  const byId = (r: RunFile) => new Map(r.cases.map((c) => [c.id, c]));
  const ca = byId(a.run);
  const cb = byId(b.run);
  const ids = [...new Set([...ca.keys(), ...cb.keys()])].sort();

  const cases: CaseDiff[] = ids.map((id) => {
    const x = ca.get(id);
    const y = cb.get(id);
    const view = (c: typeof x) =>
      c
        ? { passRate: c.summary.passRate, meanScore: c.summary.meanScore, flaky: c.summary.flaky }
        : null;
    const base = { id, category: (y ?? x)?.category ?? '', a: view(x), b: view(y) };
    if (!x || !y) {
      return {
        ...base,
        status: x ? 'only_in_a' : 'only_in_b',
        passRateDelta: null,
        scoreDelta: null,
      };
    }
    const passRateDelta =
      x.summary.passRate !== null && y.summary.passRate !== null
        ? y.summary.passRate - x.summary.passRate
        : null;
    const scoreDelta =
      x.summary.meanScore !== null && y.summary.meanScore !== null
        ? y.summary.meanScore - x.summary.meanScore
        : null;
    if (x.rubricHash !== y.rubricHash) {
      return { ...base, status: 'rubric_changed', passRateDelta, scoreDelta };
    }
    // A run that errored (model or judge) says nothing about quality: don't compare it.
    if (erroredRuns(x) > 0 || erroredRuns(y) > 0) {
      return { ...base, status: 'errored', passRateDelta, scoreDelta };
    }
    const eps = 1e-9; // 2/3 - 1 must count as a full 1/3 drop
    const regressed =
      (passRateDelta !== null && passRateDelta <= -REGRESSION_PASS_DROP + eps) ||
      (scoreDelta !== null && scoreDelta <= -REGRESSION_SCORE_DROP + eps);
    const improved =
      (passRateDelta !== null && passRateDelta >= REGRESSION_PASS_DROP - eps) ||
      (scoreDelta !== null && scoreDelta >= REGRESSION_SCORE_DROP - eps);
    return {
      ...base,
      status: regressed ? 'regressed' : improved ? 'improved' : 'unchanged',
      passRateDelta,
      scoreDelta,
    };
  });

  const changed = settingsChanged(a.run.meta, b.run.meta);
  const sa = a.run.summary;
  const sb = b.run.summary;
  const passRate = diff(sa.passRate, sb.passRate);
  return {
    a: { file: a.file, meta: a.run.meta },
    b: { file: b.file, meta: b.run.meta },
    settingsChanged: changed,
    sameSettings: changed.length === 0,
    metrics: {
      passRate,
      meanScore: diff(sa.meanScore, sb.meanScore),
      firstTokenP50: diff(sa.firstTokenMs?.p50 ?? null, sb.firstTokenMs?.p50 ?? null),
      firstTokenP95: diff(sa.firstTokenMs?.p95 ?? null, sb.firstTokenMs?.p95 ?? null),
      costPer1000Usd: diff(sa.costPer1000Usd, sb.costPer1000Usd),
    },
    overallRegressed: passRate.delta !== null && passRate.delta <= -OVERALL_PASS_DROP + 1e-9,
    cases,
    regressions: cases.filter((c) => c.status === 'regressed').length,
    improvements: cases.filter((c) => c.status === 'improved').length,
  };
}
