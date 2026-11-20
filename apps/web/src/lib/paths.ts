/** Routes reachable without signing in. Everything else requires a session. */
const PUBLIC_PATHS = ['/signin', '/invite-only'];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export const DEFAULT_SIGNED_IN_PATH = '/playbooks';

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
