import { z } from 'zod';

/**
 * Latency is Cue's core product metric. Every suggestion carries these five
 * timestamps (epoch milliseconds). Do not remove or rename them.
 *
 *   utterance_end            → speaker stopped talking (from the transcriber)
 *   suggestion_request_sent  → request sent to the model
 *   first_token              → first token received
 *   last_token               → last token received
 *   rendered_in_client       → suggestion painted in the rep's UI
 */
export const SUGGESTION_TIMESTAMP_KEYS = [
  'utterance_end',
  'suggestion_request_sent',
  'first_token',
  'last_token',
  'rendered_in_client',
] as const;

export type SuggestionTimestampKey = (typeof SUGGESTION_TIMESTAMP_KEYS)[number];

const epochMs = z.number().int().nonnegative();

export const SuggestionTimingsSchema = z
  .object({
    utterance_end: epochMs,
    suggestion_request_sent: epochMs,
    first_token: epochMs,
    last_token: epochMs,
    rendered_in_client: epochMs,
  })
  .strict()
  .superRefine((t, ctx) => {
    for (let i = 1; i < SUGGESTION_TIMESTAMP_KEYS.length; i++) {
      const prev = SUGGESTION_TIMESTAMP_KEYS[i - 1];
      const curr = SUGGESTION_TIMESTAMP_KEYS[i];
      if (prev === undefined || curr === undefined) continue;
      if (t[curr] < t[prev]) {
        ctx.addIssue({
          code: 'custom',
          path: [curr],
          message: `${curr} must not be earlier than ${prev}`,
        });
      }
    }
  });

export type SuggestionTimings = z.infer<typeof SuggestionTimingsSchema>;

/** Milliseconds from the speaker going quiet to the suggestion appearing on screen. */
export function endToEndLatencyMs(t: SuggestionTimings): number {
  return t.rendered_in_client - t.utterance_end;
}
