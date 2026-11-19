import type { TokenUsage } from '@cue/suggest';
import type { CheckResult } from './checks';
import {
  DEFAULT_JUDGE_SETTINGS,
  type JudgeSettings,
  judgeSettingsKey,
  type JudgeVerdict,
  type RateLimitInfo,
} from './judge';
import { percentile } from './latency';
import { costUsd } from './pricing';
import { isUngraded } from './scoring';

/** One generation of one case, with everything needed to audit its score later. */
export interface RunRecord {
  attempt: number;
  /** What the model wrote, and what the rep would see. */
  raw: string;
  shown: string;
  words: number;
  checks: CheckResult[];
  verdict: JudgeVerdict | null;
  judgeError: string | null;
  error: string | null;
  pass: boolean;
  score: number | null;
  reasons: string[];
  /** Request sent → first visible token, measured by the harness on a real provider. */
  firstTokenMs: number | null;
  /** First token later than production's 1.5 s deadline (production would have dropped it). */
  overDeadline: boolean;
  usage: TokenUsage | null;
  judgeUsage: TokenUsage | null;
  /** How the judge was asked (null if it wasn't). Missing in files saved before 2026-11-19. */
  judgeSettings?: JudgeSettings | null;
  /** The provider's 429 details when grading failed on a rate limit. */
  judgeRateLimit?: RateLimitInfo | null;
  /** Graded later by `pnpm eval rejudge` from the saved line (not regenerated). */
  rejudged?: boolean;
}

export interface CaseRecord {
  id: string;
  category: string;
  dataset: string;
  license: string;
  rubricHash: string;
  playbook: string;
  status: 'DRAFT' | 'REVIEWED';
  runs: RunRecord[];
}

export interface CaseSummary {
  id: string;
  category: string;
  runs: number;
  /** Runs with a known outcome: every run except the ungraded ones (model errors are graded failures). */
  graded: number;
  /** The judge failed, so the outcome is unknown. Excluded from passRate and meanScore. */
  ungraded: number;
  passes: number;
  /** passes / graded; null when no run was graded. */
  passRate: number | null;
  meanScore: number | null;
  /** Spread of the score across this case's N runs (population std dev). */
  scoreStdDev: number | null;
  /** Some graded runs passed and some failed: the result depends on luck. */
  flaky: boolean;
  /** modelErrors + ungraded. */
  errors: number;
  modelErrors: number;
}

export interface RunSummary {
  cases: number;
  runs: number;
  /** Runs with a known outcome (see CaseSummary.graded). The pass rate's denominator. */
  graded: number;
  /** Runs the judge failed to grade. Excluded from passRate and meanScore. */
  ungraded: number;
  /** ungraded / runs. Above UNGRADED_MAX_SHARE the run is not trustworthy. */
  ungradedShare: number;
  passes: number;
  /** passes / graded; null when nothing was graded. */
  passRate: number | null;
  meanScore: number | null;
  /** Mean of the per-case score std devs: how much a single run's score varies. */
  meanCaseScoreStdDev: number | null;
  flakyCases: number;
  /** modelErrors + ungraded. */
  errors: number;
  modelErrors: number;
  firstTokenMs: { count: number; p50: number; p95: number } | null;
  overDeadline: number;
  /** Model under test only. null if its price or usage is unknown. */
  costPer1000Usd: number | null;
  /** Runs whose cost is in costPer1000Usd (it's an average over these). */
  costedRuns: number;
  judgeCostUsd: number | null;
  /**
   * How many graded runs each judge setting graded, keyed "effort/maxTokens".
   * More than one key means mixed judge settings (e.g. after a rejudge).
   */
  gradedBy: Record<string, number>;
  byCategory: Record<
    string,
    { runs: number; graded: number; ungraded: number; passes: number; passRate: number | null }
  >;
}

/**
 * More than this share of ungraded runs makes a run untrustworthy: `pnpm eval`
 * exits non-zero, and `pnpm eval rejudge <file>` can grade the rest.
 */
export const UNGRADED_MAX_SHARE = 0.05;

export function tooManyUngraded(s: Pick<RunSummary, 'ungradedShare'>): boolean {
  return s.ungradedShare > UNGRADED_MAX_SHARE;
}

/**
 * Why `pnpm eval` should exit non-zero (empty = success): more than
 * UNGRADED_MAX_SHARE of the runs are ungraded, or the pass rate is below
 * --min-pass-rate (a missing pass rate is below any threshold).
 */
export function runProblems(
  s: Pick<RunSummary, 'runs' | 'ungraded' | 'ungradedShare' | 'passRate'>,
  opts: { minPassRate: number | null; file: string },
): string[] {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const problems: string[] = [];
  if (tooManyUngraded(s)) {
    problems.push(
      `${String(s.ungraded)} of ${String(s.runs)} runs (${pct(s.ungradedShare)}) are ungraded, more than the ${pct(UNGRADED_MAX_SHARE)} allowed: the pass rate is not trustworthy. Grade them with: pnpm eval rejudge ${opts.file}`,
    );
  }
  if (opts.minPassRate !== null && (s.passRate === null || s.passRate < opts.minPassRate)) {
    problems.push(
      `Pass rate ${s.passRate === null ? 'n/a' : pct(s.passRate)} is below the threshold of ${pct(opts.minPassRate)}.`,
    );
  }
  return problems;
}

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function stdDev(xs: readonly number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

export function summarizeCase(c: CaseRecord): CaseSummary {
  const graded = c.runs.filter((r) => !isUngraded(r));
  const scores = graded.map((r) => r.score).filter((s): s is number => s !== null);
  const passes = graded.filter((r) => r.pass).length;
  const ungraded = c.runs.length - graded.length;
  const modelErrors = c.runs.filter((r) => r.error !== null).length;
  return {
    id: c.id,
    category: c.category,
    runs: c.runs.length,
    graded: graded.length,
    ungraded,
    passes,
    passRate: graded.length > 0 ? passes / graded.length : null,
    meanScore: scores.length > 0 ? mean(scores) : null,
    scoreStdDev: scores.length > 0 ? stdDev(scores) : null,
    flaky: passes > 0 && passes < graded.length,
    errors: modelErrors + ungraded,
    modelErrors,
  };
}

export function summarizeRun(
  cases: readonly CaseRecord[],
  models: { model: string; judgeModel: string },
): RunSummary {
  const all = cases.flatMap((c) => c.runs);
  const graded = all.filter((r) => !isUngraded(r));
  const perCase = cases.map(summarizeCase);
  const scores = graded.map((r) => r.score).filter((s): s is number => s !== null);
  const caseSpreads = perCase
    .filter((c) => c.runs > 1)
    .map((c) => c.scoreStdDev)
    .filter((s): s is number => s !== null);
  const latencies = all
    .map((r) => r.firstTokenMs)
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);
  const costs = all
    .map((r) => costUsd(models.model, r.usage))
    .filter((c): c is number => c !== null);
  const judgeCosts = all
    .filter((r) => r.judgeUsage !== null)
    .map((r) => costUsd(models.judgeModel, r.judgeUsage));

  const byCategory: RunSummary['byCategory'] = {};
  for (const c of cases) {
    const entry = (byCategory[c.category] ??= {
      runs: 0,
      graded: 0,
      ungraded: 0,
      passes: 0,
      passRate: null,
    });
    const g = c.runs.filter((r) => !isUngraded(r));
    entry.runs += c.runs.length;
    entry.graded += g.length;
    entry.ungraded += c.runs.length - g.length;
    entry.passes += g.filter((r) => r.pass).length;
  }
  for (const e of Object.values(byCategory)) e.passRate = e.graded > 0 ? e.passes / e.graded : null;

  const passes = graded.filter((r) => r.pass).length;
  const ungraded = all.length - graded.length;
  const modelErrors = all.filter((r) => r.error !== null).length;
  return {
    cases: cases.length,
    runs: all.length,
    graded: graded.length,
    ungraded,
    ungradedShare: all.length > 0 ? ungraded / all.length : 0,
    passes,
    passRate: graded.length > 0 ? passes / graded.length : null,
    meanScore: scores.length > 0 ? mean(scores) : null,
    meanCaseScoreStdDev: caseSpreads.length > 0 ? mean(caseSpreads) : null,
    flakyCases: perCase.filter((c) => c.flaky).length,
    errors: modelErrors + ungraded,
    modelErrors,
    firstTokenMs:
      latencies.length > 0
        ? {
            count: latencies.length,
            p50: percentile(latencies, 50),
            p95: percentile(latencies, 95),
          }
        : null,
    overDeadline: all.filter((r) => r.overDeadline).length,
    costPer1000Usd: costs.length > 0 ? mean(costs) * 1000 : null,
    costedRuns: costs.length,
    judgeCostUsd:
      judgeCosts.length > 0 && judgeCosts.every((c) => c !== null)
        ? judgeCosts.reduce((a, b) => a + b, 0)
        : null,
    gradedBy: countGradedBy(all),
    byCategory,
  };
}

/**
 * Graded runs per judge setting ("medium/1024": 51, "low/512": 78). Runs saved
 * before settings were recorded used the defaults of the time.
 */
function countGradedBy(runs: readonly RunRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of runs) {
    if (r.verdict === null) continue;
    const key = judgeSettingsKey(r.judgeSettings ?? DEFAULT_JUDGE_SETTINGS);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
