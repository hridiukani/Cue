import 'server-only';
import { getSessionUser } from '@cue/db';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { auth } from '@/auth';
import { serverConfig } from '@/config';
import { INVITE_ONLY_PATH, isLoginAllowed } from '@/lib/access';
import { getDb } from '@/server/db';

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
}

export type Access =
  | { kind: 'signed_out' }
  /** Signed in with GitHub, but not on ALLOWED_GITHUB_LOGINS. */
  | { kind: 'not_invited' }
  | { kind: 'ok'; user: CurrentUser };

/**
 * Who is asking. Checks the database too (a valid cookie for a deleted user
 * counts as signed out) and, when ALLOWED_GITHUB_LOGINS is set, the login on
 * every request, so removing someone takes effect at once. Memoized per
 * render with React cache.
 */
export const getAccess = cache(async (): Promise<Access> => {
  const session = await auth();
  const id = session?.user.id;
  if (!id) return { kind: 'signed_out' };
  if (!isLoginAllowed(session.user.login, serverConfig().allowedGithubLogins)) {
    return { kind: 'not_invited' };
  }
  const user = await getSessionUser(getDb(), id);
  return user ? { kind: 'ok', user } : { kind: 'signed_out' };
});

/** The signed-in, allowed user, or null. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const access = await getAccess();
  return access.kind === 'ok' ? access.user : null;
}

/**
 * Call at the top of every protected page and server action. Redirects to
 * /signin when there's no valid user, and to /invite-only when the user isn't
 * on ALLOWED_GITHUB_LOGINS. This, not the proxy, is the real check.
 */
export async function requireUser(): Promise<CurrentUser> {
  const access = await getAccess();
  if (access.kind === 'not_invited') redirect(INVITE_ONLY_PATH);
  if (access.kind === 'signed_out') redirect('/signin');
  return access.user;
}
