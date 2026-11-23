import { ProspectTrigger, type WindowUtterance } from '@cue/suggest';

/**
 * Would production even ask for a suggestion at this case's moment?
 *
 * Production skips an isolated short prospect reply (at most 3 words, no "?")
 * but triggers on the third short reply in a row (disengagement); see
 * @cue/suggest prospect-trigger.ts. The eval harness calls the prompt
 * directly, so it grades a line for every case, including moments production
 * would skip. This replays the case window's prospect lines, in order,
 * through the very same ProspectTrigger and reports the decision for the
 * final one (the line the case asks a suggestion for).
 *
 * It is a report only: flagged cases stay in the pass rate as before.
 */
export function productionWouldSkip(window: readonly WindowUtterance[]): boolean {
  const trigger = new ProspectTrigger();
  let last: ReturnType<ProspectTrigger['decide']> | null = null;
  for (const u of window) {
    if (u.speaker === 'prospect') last = trigger.decide(u.text);
  }
  return last?.kind === 'skip';
}
