import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EmailAlreadyLinkedError,
  findOrCreateOAuthUser,
  getSessionUser,
} from '../src/repositories/users';
import { authAccounts, users } from '../src/schema';
import { connectTestDb, makeUser } from './helpers';

const { db, close } = connectTestDb();
afterAll(close);

const identity = () => ({
  provider: 'github',
  providerAccountId: randomUUID(),
  email: `gh-${randomUUID()}@test.local`,
  name: 'GitHub User',
});

describe('findOrCreateOAuthUser', () => {
  it('creates a user and account link on first sign-in', async () => {
    const id = identity();
    const userId = await findOrCreateOAuthUser(db, id);

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user).toMatchObject({ email: id.email, name: id.name });
    const links = await db.select().from(authAccounts).where(eq(authAccounts.userId, userId));
    expect(links).toMatchObject([{ provider: 'github', providerAccountId: id.providerAccountId }]);
  });

  it('returns the same user on later sign-ins, even if the email changed', async () => {
    const id = identity();
    const first = await findOrCreateOAuthUser(db, id);
    const again = await findOrCreateOAuthUser(db, { ...id, email: `new-${id.email}` });
    expect(again).toBe(first);
  });

  it('refuses to link a new identity to an existing email', async () => {
    const existing = await makeUser(db);
    await expect(
      findOrCreateOAuthUser(db, { ...identity(), email: existing.email.toUpperCase() }),
    ).rejects.toBeInstanceOf(EmailAlreadyLinkedError);
    // Nothing half-created: the transaction rolled back.
    expect(
      await db.select().from(authAccounts).where(eq(authAccounts.userId, existing.id)),
    ).toEqual([]);
  });
});

describe('getSessionUser', () => {
  it('returns the user, or null once they are deleted', async () => {
    const user = await makeUser(db);
    expect(await getSessionUser(db, user.id)).toMatchObject({ id: user.id, email: user.email });
    await db.delete(users).where(eq(users.id, user.id));
    expect(await getSessionUser(db, user.id)).toBeNull();
  });
});
