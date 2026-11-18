import type { DeterministicResult } from './checks';
import { type JudgeVerdict, PASS_MIN_SCORE } from './judge';

/**
 * One generated line passes only if ALL of these hold:
 * - every deterministic check passes (length, one line, no preamble, …);
 * - the judge returned a valid verdict;
 * - no "must not" item is violated;
 * - the judge's score is at least PASS_MIN_SCORE (4 of 5).
 *
 * A run that errored (model or judge failure) is a failure too: dropping it
 * would make the pass rate look better than what a rep would get.
 */
export interface RunScore {
  pass: boolean;
  /** 1-5, or null if the judge couldn't grade it. An empty line scores 1 without asking. */
  score: number | null;
  reasons: string[];
}

export function scoreRun(input: {
  checks: DeterministicResult | null;
  verdict: JudgeVerdict | null;
  error: string | null;
}): RunScore {
  const reasons: string[] = [];
  if (input.error) reasons.push(input.error);
  if (input.checks) {
    for (const c of input.checks.checks) {
      if (!c.pass) reasons.push(`${c.id}${c.detail ? `: ${c.detail}` : ''}`);
    }
  }
  const empty = input.checks !== null && input.checks.shown === '';
  const score = empty ? 1 : (input.verdict?.score ?? null);
  if (!empty && !input.verdict && !input.error) reasons.push('not graded');
  if (input.verdict) {
    input.verdict.mustNotViolated.forEach((v, i) => {
      if (v) reasons.push(`violates N${String(i + 1)}`);
    });
    if (input.verdict.score < PASS_MIN_SCORE) {
      reasons.push(`score ${String(input.verdict.score)} < ${String(PASS_MIN_SCORE)}`);
    }
  }
  const pass =
    input.error === null &&
    input.checks?.pass === true &&
    input.verdict !== null &&
    !input.verdict.mustNotViolated.some(Boolean) &&
    input.verdict.score >= PASS_MIN_SCORE;
  return { pass, score, reasons };
}
