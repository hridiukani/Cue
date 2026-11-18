import type { TokenUsage } from '@cue/suggest';
import type { CheckResult } from './checks';
import type { JudgeVerdict } from './judge';
import { percentile } from './latency';
import { costUsd } from './pricing';

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
  passes: number;
  passRate: number;
  meanScore: number | null;
  /** Spread of the score across this case's N runs (population std dev). */
  scoreStdDev: number | null;
  /** Some runs passed and some failed: the result depends on luck. */
  flaky: boolean;
  errors: number;
}

export interface RunSummary {
  cases: number;
  runs: number;
  passes: number;
  passRate: number;
  meanScore: number | null;
  /** Mean of the per-case score std devs: how much a single run's score varies. */
  meanCaseScoreStdDev: number | null;
  flakyCases: number;
  errors: number;
  firstTokenMs: { count: number; p50: number; p95: number } | null;
  overDeadline: number;
  /** Model under test only. null if its price or usage is unknown. */
  costPer1000Usd: number | null;
  /** Runs whose cost is in costPer1000Usd (it's an average over these). */
  costedRuns: number;
  judgeCostUsd: number | null;
  byCategory: Record<string, { runs: number; passes: number; passRate: number }>;
}

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function stdDev(xs: readonly number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

export function summarizeCase(c: CaseRecord): CaseSummary {
  const scores = c.runs.map((r) => r.score).filter((s): s is number => s !== null);
  const passes = c.runs.filter((r) => r.pass).length;
  return {
    id: c.id,
    category: c.category,
    runs: c.runs.length,
    passes,
    passRate: c.runs.length > 0 ? passes / c.runs.length : 0,
    meanScore: scores.length > 0 ? mean(scores) : null,
    scoreStdDev: scores.length > 0 ? stdDev(scores) : null,
    flaky: passes > 0 && passes < c.runs.length,
    errors: c.runs.filter((r) => r.error !== null).length,
  };
}

export function summarizeRun(
  cases: readonly CaseRecord[],
  models: { model: string; judgeModel: string },
): RunSummary {
  const all = cases.flatMap((c) => c.runs);
  const perCase = cases.map(summarizeCase);
  const scores = all.map((r) => r.score).filter((s): s is number => s !== null);
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
    const entry = (byCategory[c.category] ??= { runs: 0, passes: 0, passRate: 0 });
    entry.runs += c.runs.length;
    entry.passes += c.runs.filter((r) => r.pass).length;
  }
  for (const e of Object.values(byCategory)) e.passRate = e.runs > 0 ? e.passes / e.runs : 0;

  const passes = all.filter((r) => r.pass).length;
  return {
    cases: cases.length,
    runs: all.length,
    passes,
    passRate: all.length > 0 ? passes / all.length : 0,
    meanScore: scores.length > 0 ? mean(scores) : null,
    meanCaseScoreStdDev: caseSpreads.length > 0 ? mean(caseSpreads) : null,
    flakyCases: perCase.filter((c) => c.flaky).length,
    errors: all.filter((r) => r.error !== null).length,
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
    byCategory,
  };
}
