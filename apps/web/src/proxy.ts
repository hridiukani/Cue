import NextAuth from 'next-auth';
import type { NextFetchEvent, NextRequest } from 'next/server';
import { authConfig } from '@/auth.config';

const { auth } = NextAuth(authConfig);

/**
 * With a lazy (function) config, Auth.js supports calling `auth(request, event)`
 * directly as the proxy: it runs the `authorized` callback and returns its
 * redirect, or redirects to /signin if it returns false (next-auth
 * lib/index.js, "middleware.ts inline"). Its published types don't describe
 * this call form, so we narrow to exactly that signature here.
 */
const authGate = auth as unknown as (
  request: NextRequest,
  event: NextFetchEvent,
) => Promise<Response>;

/**
 * Optimistic auth gate: signed-out requests to any non-public route are
 * redirected to /signin. This only reads the session cookie; pages and server
 * actions still verify the user themselves, so a proxy bypass can't expose data.
 */
export function proxy(request: NextRequest, event: NextFetchEvent): Promise<Response> {
  return authGate(request, event);
}

export const config = {
  // Everything except Auth.js's own routes and static assets.
  matcher: ['/((?!api/auth|_next/static|_next/image|favicon.ico).*)'],
};
