import { pgEnum } from 'drizzle-orm/pg-core';

export const speakerEnum = pgEnum('speaker', ['rep', 'prospect']);

export const callStatusEnum = pgEnum('call_status', ['live', 'ended', 'failed']);

export const suggestionStatusEnum = pgEnum('suggestion_status', [
  'streaming',
  'complete',
  'failed',
]);

export const feedbackSignalEnum = pgEnum('feedback_signal', [
  'thumbs_up',
  'thumbs_down',
  'used',
  'ignored',
]);

/** Whether a recording's utterance times are real or estimated from text length. */
export const timingEnum = pgEnum('timing', ['real', 'estimated']);

/** A call is either a live coaching session or a replay of an imported recording. */
export const callModeEnum = pgEnum('call_mode', ['live', 'replay']);

/** Why a suggestion failed (null for completed ones). Mirrors SuggestionFailureReasonSchema. */
export const suggestionFailureReasonEnum = pgEnum('suggestion_failure_reason', [
  'cancelled_newer',
  'cancelled_rep_spoke',
  'cancelled_stopped',
  'first_token_timeout',
  'timeout',
  'rate_limited',
  'api_error',
  'empty_output',
]);
