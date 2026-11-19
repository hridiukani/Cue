import type { DeterministicResult } from './checks';
import { type JudgeVerdict, PASS_MIN_SCORE } from './judge';

/**
 * One generated line passes only if ALL of these hold:
 * - every deterministic check passes (length, one line, no preamble, …);
 * - the judge returned a valid verdict;
 * - no "must not" item is violated;
 * - the judge's score is at least PASS_MIN_SCORE (4 of 5).
 *
 * A MODEL error is a failure: the rep would have got nothing, and dropping it
 * would make the pass rate look better than what a rep would get.
 *
 * A JUDGE failure (rate limit, timeout, unreadable verdict) is different: the
 * line exists but nobody graded it, so its outcome is unknown. It is UNGRADED:
 * excluded from the pass rate and mean score, counted under errors, and shown
 * prominently. Judge failures are unrelated to the line's quality (a 429
 * hits whatever line is next), so the graded runs stay a fair sample, whereas
 * counting ungraded runs as failures understates the pass rate (the
 * 2026-11-19 run read 14.7% with 78 of 129 runs ungraded).
 */
export interface RunScore {
  pass: boolean;
  /** Needed a judge verdict and didn't get one: the outcome is unknown. */
  ungraded: boolean;
  /** 1-5, or null if the judge couldn't grade it. An empty line scores 1 without asking. */
  score: number | null;
  reasons: string[];
}

export function scoreRun(input: {
  checks: DeterministicResult | null;
  verdict: JudgeVerdict | null;
  /** The model under test failed (no line at all). */
  error: string | null;
  /** The judge failed on a line that needed grading. */
  judgeError?: string | null;
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
  const ungraded = input.error === null && input.checks !== null && !empty && !input.verdict;
  if (ungraded) {
    reasons.push(input.judgeError ? `ungraded: ${input.judgeError}` : 'ungraded');
  }
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
  return { pass, ungraded, score, reasons };
}

/**
 * The same rule, read back from a saved run (works for files written before
 * the `ungraded` idea existed): the model produced a non-empty line, but
 * there is no verdict.
 */
export function isUngraded(run: {
  error: string | null;
  shown: string;
  verdict: unknown;
}): boolean {
  return run.error === null && run.shown !== '' && run.verdict === null;
}
