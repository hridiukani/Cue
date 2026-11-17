import type { CoachingNote, NextStep, RaisedObjection } from '@cue/shared';
import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { calls } from './calls';
import { createdAt } from './columns';

/** Post-call summary. At most one per call: call_id is the primary key. */
export const callSummaries = pgTable('call_summaries', {
  callId: uuid('call_id')
    .primaryKey()
    .references(() => calls.id, { onDelete: 'cascade' }),
  summary: text('summary').notNull(),
  objectionsRaised: jsonb('objections_raised')
    .$type<RaisedObjection[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  nextSteps: jsonb('next_steps')
    .$type<NextStep[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  coachingNotes: jsonb('coaching_notes')
    .$type<CoachingNote[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  createdAt: createdAt(),
});

export type CallSummary = typeof callSummaries.$inferSelect;
export type NewCallSummary = typeof callSummaries.$inferInsert;
