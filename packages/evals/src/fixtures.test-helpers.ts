// Test helpers only (not exported from the package).
import type { RunFile, RunMeta } from './results';
import { type CaseRecord, type RunRecord, summarizeCase, summarizeRun } from './summary';

export function fakeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    attempt: 1,
    raw: 'What would it cost to keep doing this by hand?',
    shown: 'What would it cost to keep doing this by hand?',
    words: 11,
    checks: [],
    verdict: null,
    judgeError: null,
    error: null,
    pass: true,
    score: 4,
    reasons: [],
    firstTokenMs: 300,
    overDeadline: false,
    usage: { promptTokens: 500, completionTokens: 60, reasoningTokens: 30 },
    judgeUsage: { promptTokens: 900, completionTokens: 90, reasoningTokens: 40 },
    ...over,
  };
}

/** A case with `passes` passing runs out of `n`, all at `score` (failures at score - 2). */
export function fakeCase(
  id: string,
  passes: number,
  n: number,
  opts: { score?: number; rubricHash?: string; category?: string } = {},
): CaseRecord {
  const score = opts.score ?? 4;
  return {
    id,
    category: opts.category ?? 'price_objection',
    dataset: 'gwenshap/sales-transcripts',
    license: 'apache-2.0',
    rubricHash: opts.rubricHash ?? `hash-${id}`,
    playbook: 'none',
    status: 'DRAFT',
    runs: Array.from({ length: n }, (_, i) =>
      fakeRun({
        attempt: i + 1,
        pass: i < passes,
        score: i < passes ? score : Math.max(1, score - 2),
        reasons: i < passes ? [] : ['score 2 < 4'],
      }),
    ),
  };
}

export function fakeRunFile(cases: CaseRecord[], meta: Partial<RunMeta> = {}): RunFile {
  const m: RunMeta = {
    runId: 'run-1',
    createdAt: '2026-11-17T12:00:00.000Z',
    git: { commit: 'abcdef1234567890', dirty: false },
    model: 'openai/gpt-oss-20b',
    judgeModel: 'openai/gpt-oss-120b',
    judgeVersion: 'judge-v1',
    promptVersion: 'suggest-v1',
    runsPerCase: 3,
    concurrency: 4,
    casesFile: { path: 'dataset/cases.jsonl', sha256: 'aaa' },
    selection: { smoke: false, caseIds: null, categories: null },
    skipped: [],
    pricing: { url: 'https://console.groq.com/docs/models', checkedOn: '2026-11-17' },
    ...meta,
  };
  return {
    schemaVersion: 1,
    meta: m,
    summary: summarizeRun(cases, { model: m.model, judgeModel: m.judgeModel }),
    cases: cases.map((c) => ({ ...c, summary: summarizeCase(c) })),
  };
}
