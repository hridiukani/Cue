import { index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id } from './columns';
import { users } from './users';

/**
 * Links an OAuth identity (e.g. a GitHub account) to a Cue user. Sign-in looks
 * users up by (provider, provider_account_id), never by email: the provider's
 * account id is stable, while emails can change or be reused.
 */
export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('auth_accounts_provider_account_key').on(t.provider, t.providerAccountId),
    index('auth_accounts_user_id_idx').on(t.userId),
  ],
);

export type AuthAccount = typeof authAccounts.$inferSelect;
