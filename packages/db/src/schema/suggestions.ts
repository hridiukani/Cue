import { foreignKey, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { calls } from './calls';
import { createdAt, id, timestamptz } from './columns';
import { suggestionStatusEnum } from './enums';
import { utterances } from './utterances';

/**
 * One suggested next line for the rep.
 *
 * LATENCY INSTRUMENTATION: never remove these five timestamps (see CLAUDE.md).
 * They are nullable because they're filled in as the suggestion progresses.
 * Ordering is not enforced here: client_rendered_at comes from the browser's
 * clock, so a DB check could reject real data. Use toSuggestionTimings().
 */
export const suggestions = pgTable(
  'suggestions',
  {
    id: id(),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    // The utterance whose end triggered this suggestion. Composite FK below
    // guarantees it belongs to the same call.
    utteranceId: uuid('utterance_id').notNull(),
    text: text('text').notNull().default(''),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    status: suggestionStatusEnum('status').notNull().default('streaming'),

    utteranceEndAt: timestamptz('utterance_end_at'),
    requestSentAt: timestamptz('request_sent_at'),
    firstTokenAt: timestamptz('first_token_at'),
    lastTokenAt: timestamptz('last_token_at'),
    clientRenderedAt: timestamptz('client_rendered_at'),

    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'suggestions_utterance_same_call_fk',
      columns: [t.utteranceId, t.callId],
      foreignColumns: [utterances.id, utterances.callId],
    }).onDelete('cascade'),
    index('suggestions_call_id_created_at_idx').on(t.callId, t.createdAt),
    index('suggestions_utterance_id_idx').on(t.utteranceId),
    index('suggestions_prompt_version_idx').on(t.promptVersion),
  ],
);

export type Suggestion = typeof suggestions.$inferSelect;
export type NewSuggestion = typeof suggestions.$inferInsert;
