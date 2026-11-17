import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { callModeEnum, callStatusEnum } from './enums';
import { playbooks } from './playbooks';
import { recordings } from './recordings';
import { users } from './users';

/**
 * A coaching session owned by a user: a live call, or a replay of an imported
 * recording. The session owns its status, utterances, suggestions, feedback
 * and summary. Each replay is a new row.
 */
export const calls = pgTable(
  'calls',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // A call can run without a playbook. Deleting a playbook that calls still use
    // is refused. NO ACTION (not RESTRICT) so the check runs at the end of the
    // statement: deleting a user, which cascades to both their playbooks and
    // their calls, still works.
    playbookId: uuid('playbook_id').references(() => playbooks.id, { onDelete: 'no action' }),
    mode: callModeEnum('mode').notNull().default('live'),
    // The recording a replay plays. SET NULL so session history (utterances,
    // suggestions, feedback) survives if the recording is ever deleted. Because
    // of that, "replay needs a recording" is enforced when the session is
    // created (createReplaySession), not by a CHECK that SET NULL would violate.
    recordingId: uuid('recording_id').references(() => recordings.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    endedAt: timestamptz('ended_at'),
    status: callStatusEnum('status').notNull().default('live'),
    // Last saved playback position, so a session can resume after a reconnect or restart.
    positionMs: integer('position_ms').notNull().default(0),
    // Updated on every emit and control; live sessions idle for an hour are ended by a cleanup job.
    lastActivityAt: timestamptz('last_activity_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index('calls_user_id_started_at_idx').on(t.userId, t.startedAt.desc()),
    index('calls_playbook_id_idx').on(t.playbookId),
    index('calls_recording_id_idx').on(t.recordingId),
    // Only live sessions are scanned by the idle cleanup.
    index('calls_live_last_activity_idx')
      .on(t.lastActivityAt)
      .where(sql`${t.status} = 'live'`),
    check('calls_ended_after_started', sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}`),
    check('calls_position_nonnegative', sql`${t.positionMs} >= 0`),
  ],
);

export type Call = typeof calls.$inferSelect;
export type NewCall = typeof calls.$inferInsert;
