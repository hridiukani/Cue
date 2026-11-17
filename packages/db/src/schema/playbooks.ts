import type { PlaybookObjection } from '@cue/shared';
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { users } from './users';

/** What the rep is selling and how to handle pushback. Feeds the suggestion prompt. */
export const playbooks = pgTable(
  'playbooks',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    productDescription: text('product_description').notNull(),
    idealCustomer: text('ideal_customer').notNull(),
    objections: jsonb('objections')
      .$type<PlaybookObjection[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    toneNotes: text('tone_notes'),
    createdAt: createdAt(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('playbooks_user_id_idx').on(t.userId)],
);

export type Playbook = typeof playbooks.$inferSelect;
export type NewPlaybook = typeof playbooks.$inferInsert;
