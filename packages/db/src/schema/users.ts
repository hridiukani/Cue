import { sql } from 'drizzle-orm';
import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id } from './columns';

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name'),
    createdAt: createdAt(),
  },
  (t) => [
    // Case-insensitive uniqueness: Rep@x.com and rep@x.com are the same person.
    uniqueIndex('users_email_lower_key').on(sql`lower(${t.email})`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
