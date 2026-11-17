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
