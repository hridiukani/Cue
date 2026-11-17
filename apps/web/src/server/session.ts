import 'server-only';
import { getSessionUser } from '@cue/db';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { auth } from '@/auth';
import { getDb } from '@/server/db';

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
}

/**
 * The signed-in user, or null. Checks the database too: a valid cookie for a
 * deleted user counts as signed out. Memoized per render with React cache.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth();
  const id = session?.user.id;
  if (!id) return null;
  return getSessionUser(getDb(), id);
});

/**
 * Call at the top of every protected page and server action. Redirects to
 * /signin when there's no valid user. This, not the proxy, is the real check.
 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/signin');
  return user;
}
