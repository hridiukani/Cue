import { SuggestionTimingsSchema, type SuggestionTimings } from '@cue/shared';
import type { Suggestion } from './schema';

export type SuggestionTimestampColumns = Pick<
  Suggestion,
  'utteranceEndAt' | 'requestSentAt' | 'firstTokenAt' | 'lastTokenAt' | 'clientRenderedAt'
>;

/**
 * Map a suggestions row's latency columns to the shared timing shape (epoch ms).
 *
 * - Returns null while any timestamp is still missing (streaming, failed, or
 *   never rendered). Callers should count these, not ignore them.
 * - Throws if the timestamps are out of order: that means a clock or
 *   instrumentation bug, which must be loud, not silently skew p50/p95.
 */
export function toSuggestionTimings(row: SuggestionTimestampColumns): SuggestionTimings | null {
  const { utteranceEndAt, requestSentAt, firstTokenAt, lastTokenAt, clientRenderedAt } = row;
  if (!utteranceEndAt || !requestSentAt || !firstTokenAt || !lastTokenAt || !clientRenderedAt) {
    return null;
  }
  return SuggestionTimingsSchema.parse({
    utterance_end: utteranceEndAt.getTime(),
    suggestion_request_sent: requestSentAt.getTime(),
    first_token: firstTokenAt.getTime(),
    last_token: lastTokenAt.getTime(),
    rendered_in_client: clientRenderedAt.getTime(),
  });
}
