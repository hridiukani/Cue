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
