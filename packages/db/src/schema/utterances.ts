import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  real,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { calls } from './calls';
import { createdAt, id } from './columns';
import { speakerEnum } from './enums';

/**
 * One finished stretch of speech by one speaker. Only final transcripts are
 * stored for now; interim results stay in the realtime server's memory.
 * started_ms / ended_ms are milliseconds since the call started.
 */
export const utterances = pgTable(
  'utterances',
  {
    id: id(),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    speaker: speakerEnum('speaker').notNull(),
    text: text('text').notNull(),
    startedMs: integer('started_ms').notNull(),
    endedMs: integer('ended_ms').notNull(),
    isFinal: boolean('is_final').notNull().default(true),
    confidence: real('confidence'),
    createdAt: createdAt(),
  },
  (t) => [
    index('utterances_call_id_started_ms_idx').on(t.callId, t.startedMs),
    // Target for suggestions' composite FK: lets the DB check that a suggestion's
    // triggering utterance belongs to the same call.
    unique('utterances_id_call_id_key').on(t.id, t.callId),
    check('utterances_started_ms_nonnegative', sql`${t.startedMs} >= 0`),
    check('utterances_ended_after_started', sql`${t.endedMs} >= ${t.startedMs}`),
    check(
      'utterances_confidence_range',
      sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 1)`,
    ),
  ],
);

export type Utterance = typeof utterances.$inferSelect;
export type NewUtterance = typeof utterances.$inferInsert;
