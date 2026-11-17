import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { authAccounts, users } from '../schema';

export interface OAuthIdentity {
  provider: string;
  providerAccountId: string;
  email: string;
  name: string | null;
}

/** Thrown when an OAuth sign-in's email already belongs to a different Cue user. */
export class EmailAlreadyLinkedError extends Error {
  constructor() {
    super('This email already belongs to an account that signs in another way.');
    this.name = 'EmailAlreadyLinkedError';
  }
}

/**
 * Return the Cue user id for an OAuth identity, creating the user on first
 * sign-in. Lookup is by (provider, providerAccountId) only.
 *
 * If no link exists but the email is taken, we refuse instead of linking:
 * auto-linking by email lets anyone who controls that address on another
 * provider take over the account.
 */
export async function findOrCreateOAuthUser(db: Db, identity: OAuthIdentity): Promise<string> {
  return db.transaction(async (tx) => {
    const [linked] = await tx
      .select({ userId: authAccounts.userId })
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.provider, identity.provider),
          eq(authAccounts.providerAccountId, identity.providerAccountId),
        ),
      );
    if (linked) return linked.userId;

    const [emailTaken] = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = lower(${identity.email})`);
    if (emailTaken) throw new EmailAlreadyLinkedError();

    const [user] = await tx
      .insert(users)
      .values({ email: identity.email, name: identity.name })
      .returning({ id: users.id });
    if (!user) throw new Error('user insert returned nothing');

    await tx.insert(authAccounts).values({
      userId: user.id,
      provider: identity.provider,
      providerAccountId: identity.providerAccountId,
    });
    return user.id;
  });
}

/** Minimal user fields for the session; null if the user no longer exists. */
export async function getSessionUser(
  db: Db,
  userId: string,
): Promise<{ id: string; email: string; name: string | null } | null> {
  const [row] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, userId));
  return row ?? null;
}
