import NextAuth from 'next-auth';
import { authConfig } from '@/auth.config';

/**
 * Optimistic auth gate: signed-out requests to any non-public route are
 * redirected to /signin (via the `authorized` callback). This only reads the
 * session cookie; pages and server actions still verify the user themselves,
 * so a proxy bypass can't expose data.
 */
export const { auth: proxy } = NextAuth(authConfig);

export const config = {
  // Everything except Auth.js's own routes and static assets.
  matcher: ['/((?!api/auth|_next/static|_next/image|favicon.ico).*)'],
};
