import { wordCount } from './prompt';

/**
 * Which prospect lines are worth a suggestion?
 *
 * Lives in @cue/suggest so production (apps/realtime's SuggestionEngine) and
 * the eval harness (its production-skip report) use the very same rule.
 *
 * The prospect-side twin of the rep backchannel rule
 * (apps/realtime/src/suggestions/backchannel.ts):
 *
 * - **Substantive line** (more than PROSPECT_SKIP_MAX_WORDS words, or any line
 *   with a "?"): trigger, as always.
 * - **Isolated short reply** ("yeah", "okay sure", "mm-hmm"): skip. There's
 *   nothing to answer, and a suggestion would only interrupt. It's recorded
 *   as status 'skipped' / reason 'prospect_backchannel', never silently dropped.
 * - **DISENGAGED_RUN_LENGTH short replies in a row**: trigger. A prospect who
 *   keeps answering "yeah… sure… okay" is disengaging, which is exactly when
 *   the rep needs help (the eval has a "disengaged" category for it).
 *
 * The run counts consecutive prospect lines only (rep lines in between don't
 * break it; that's how a conversation alternates). It resets after a
 * substantive line and after it triggers, so the next disengagement
 * suggestion needs another full run. Both limits are inclusive in the way
 * that matters: exactly 3 words is still short.
 */
export const PROSPECT_SKIP_MAX_WORDS = 3;
export const DISENGAGED_RUN_LENGTH = 3;

export interface ProspectTriggerThresholds {
  /** A line with at most this many words and no "?" is a short reply. */
  maxShortWords: number;
  /** This many short replies in a row trigger a suggestion. */
  disengagedRun: number;
}

export const DEFAULT_PROSPECT_TRIGGER: ProspectTriggerThresholds = {
  maxShortWords: PROSPECT_SKIP_MAX_WORDS,
  disengagedRun: DISENGAGED_RUN_LENGTH,
};

export type ProspectDecision =
  | { kind: 'trigger'; why: 'substantive' | 'disengaged' }
  | { kind: 'skip'; reason: 'prospect_backchannel'; run: number };

/** A short prospect reply: at most `maxWords` words and no question mark. */
export function isShortProspectReply(
  text: string,
  maxWords: number = PROSPECT_SKIP_MAX_WORDS,
): boolean {
  return wordCount(text) <= maxWords && !text.includes('?');
}

/** One per session: remembers how many short prospect replies came in a row. */
export class ProspectTrigger {
  private run = 0;

  constructor(private readonly thresholds: ProspectTriggerThresholds = DEFAULT_PROSPECT_TRIGGER) {}

  /** Short replies in a row so far (0 after a substantive line or a trigger). */
  get shortRun(): number {
    return this.run;
  }

  /** Call once per finalized prospect line, in order. */
  decide(text: string): ProspectDecision {
    if (!isShortProspectReply(text, this.thresholds.maxShortWords)) {
      this.run = 0;
      return { kind: 'trigger', why: 'substantive' };
    }
    this.run += 1;
    if (this.run >= this.thresholds.disengagedRun) {
      this.run = 0;
      return { kind: 'trigger', why: 'disengaged' };
    }
    return { kind: 'skip', reason: 'prospect_backchannel', run: this.run };
  }
}
