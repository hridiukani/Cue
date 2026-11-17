import { pgTable, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id } from './columns';
import { feedbackSignalEnum } from './enums';
import { suggestions } from './suggestions';

/**
 * How the rep reacted to a suggestion. A suggestion can carry several signals
 * (e.g. 'used' and 'thumbs_up') but each signal at most once.
 */
export const suggestionFeedback = pgTable(
  'suggestion_feedback',
  {
    id: id(),
    suggestionId: uuid('suggestion_id')
      .notNull()
      .references(() => suggestions.id, { onDelete: 'cascade' }),
    signal: feedbackSignalEnum('signal').notNull(),
    createdAt: createdAt(),
  },
  // The unique index also serves lookups by suggestion_id (its leading column).
  (t) => [unique('suggestion_feedback_suggestion_signal_key').on(t.suggestionId, t.signal)],
);

export type SuggestionFeedback = typeof suggestionFeedback.$inferSelect;
export type NewSuggestionFeedback = typeof suggestionFeedback.$inferInsert;
