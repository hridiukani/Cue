import 'server-only';
import { EmailAlreadyLinkedError, findOrCreateOAuthUser, type OAuthIdentity } from '@cue/db';
import NextAuth from 'next-auth';
import { z } from 'zod';
import { authConfig } from '@/auth.config';
import { getDb } from '@/server/db';

/** Sign-in error codes shown on /signin (see app/signin/page.tsx). */
export const SIGNIN_ERROR = { noEmail: 'NoEmail', emailInUse: 'EmailInUse' } as const;

function identityFrom(
  account: { provider: string; providerAccountId: string },
  user: { email?: string | null; name?: string | null },
): OAuthIdentity | null {
  if (!user.email) return null;
  return {
    provider: account.provider,
    providerAccountId: account.providerAccountId,
    email: user.email,
    name: user.name ?? null,
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const base = authConfig();
  return {
    ...base,
    callbacks: {
      ...base.callbacks,
      // Runs once per sign-in. Creates the Cue user on first sign-in, or
      // refuses (with a readable reason) when that isn't safe.
      async signIn({ account, user }) {
        if (!account) return false;
        const identity = identityFrom(account, user);
        if (!identity) return `/signin?error=${SIGNIN_ERROR.noEmail}`;
        try {
          await findOrCreateOAuthUser(getDb(), identity);
          return true;
        } catch (err) {
          if (err instanceof EmailAlreadyLinkedError) {
            return `/signin?error=${SIGNIN_ERROR.emailInUse}`;
          }
          throw err;
        }
      },
      // On sign-in `account` is set: store the Cue user id in the encrypted
      // session cookie. On later requests, just pass the token through.
      async jwt({ token, account, user }) {
        if (account) {
          const identity = identityFrom(account, user);
          if (!identity) throw new Error('jwt callback: sign-in without email');
          token.uid = await findOrCreateOAuthUser(getDb(), identity);
        }
        return token;
      },
      session({ session, token }) {
        const uid = z.uuid().safeParse(token.uid);
        if (uid.success) session.user.id = uid.data;
        return session;
      },
    },
  };
});
