import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { callStatusEnum } from './enums';
import { playbooks } from './playbooks';
import { users } from './users';

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
    title: text('title').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    endedAt: timestamptz('ended_at'),
    status: callStatusEnum('status').notNull().default('live'),
    createdAt: createdAt(),
  },
  (t) => [
    index('calls_user_id_started_at_idx').on(t.userId, t.startedAt.desc()),
    index('calls_playbook_id_idx').on(t.playbookId),
    check('calls_ended_after_started', sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}`),
  ],
);

export type Call = typeof calls.$inferSelect;
export type NewCall = typeof calls.$inferInsert;
