import type { NextAuthConfig } from 'next-auth';
import GitHub from 'next-auth/providers/github';
import { serverConfig } from '@/config';
import { isPublicPath } from '@/lib/paths';

/**
 * Auth.js config with no database access, so the proxy (which runs before
 * every request) stays light. Database callbacks are added in auth.ts.
 * A function, not an object, so secrets are read at request time, not build time.
 */
export function authConfig(): NextAuthConfig {
  const cfg = serverConfig();
  return {
    secret: cfg.authSecret,
    providers: [GitHub({ clientId: cfg.githubClientId, clientSecret: cfg.githubClientSecret })],
    session: { strategy: 'jwt' },
    pages: { signIn: '/signin', error: '/signin' },
    callbacks: {
      // Optimistic check used by the proxy. Real authorization happens again in
      // every page and server action (see server/session.ts).
      authorized({ auth, request }) {
        const { pathname, search } = request.nextUrl;
        if (isPublicPath(pathname) || auth?.user) return true;
        // Redirect ourselves (instead of returning false) so callbackUrl is a
        // relative path, which safeRedirectPath accepts after sign-in.
        const signInUrl = new URL('/signin', request.nextUrl);
        signInUrl.searchParams.set('callbackUrl', `${pathname}${search}`);
        return Response.redirect(signInUrl);
      },
    },
  };
}
