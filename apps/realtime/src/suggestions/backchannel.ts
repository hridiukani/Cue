/**
 * When does the rep's speech cancel a suggestion in flight?
 *
 * Short listener noises ("mm-hmm", "right", "yeah, totally") are backchannels:
 * the rep isn't taking the turn, so the suggestion is still useful. Only
 * substantial rep speech cancels it:
 *
 *   more than REP_CANCEL_MAX_WORDS words, OR longer than REP_CANCEL_MAX_MS.
 *
 * Both thresholds are exclusive: exactly 4 words or exactly 1.5 s is still a
 * backchannel. For an utterance still in progress (an interim), pass the words
 * and speaking time so far; it cancels as soon as either threshold is crossed.
 */
export const REP_CANCEL_MAX_WORDS = 4;
export const REP_CANCEL_MAX_MS = 1500;

export interface RepSpeech {
  text: string;
  /** How long the rep has been speaking in this utterance (so far, for an interim). */
  durationMs: number;
}

export interface BackchannelThresholds {
  maxWords: number;
  maxMs: number;
}

export const DEFAULT_BACKCHANNEL_THRESHOLDS: BackchannelThresholds = {
  maxWords: REP_CANCEL_MAX_WORDS,
  maxMs: REP_CANCEL_MAX_MS,
};

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** True if this rep speech is substantial enough to cancel a suggestion. */
export function repSpeechCancelsSuggestion(
  speech: RepSpeech,
  thresholds: BackchannelThresholds = DEFAULT_BACKCHANNEL_THRESHOLDS,
): boolean {
  return countWords(speech.text) > thresholds.maxWords || speech.durationMs > thresholds.maxMs;
}
