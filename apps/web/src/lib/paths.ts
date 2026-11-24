/** Public only as these exact paths (the landing page). */
const PUBLIC_EXACT = ['/'];
/** Public along with everything under them. */
const PUBLIC_PREFIXES = ['/signin', '/invite-only'];

/** Routes reachable without signing in. Everything else requires a session. */
export function isPublicPath(pathname: string): boolean {
  // "/" must be an exact match: as a prefix it would make every page public.
  if (PUBLIC_EXACT.includes(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Where a sign-in lands when it didn't come from a protected page: the call library. */
export const DEFAULT_SIGNED_IN_PATH = '/calls';

/**
 * Where to send the user after sign-in. Only same-site relative paths are
 * allowed, so a crafted ?callbackUrl= can't redirect to another site.
 */
export function safeRedirectPath(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SIGNED_IN_PATH;
  // Must be a single leading slash: "//evil.com" and "/\evil.com" are protocol-relative.
  if (!/^\/(?![/\\])/.test(value)) return DEFAULT_SIGNED_IN_PATH;
  if (isPublicPath(new URL(value, 'http://x').pathname)) return DEFAULT_SIGNED_IN_PATH;
  return value;
}
