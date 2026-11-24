/** The signed-in app's top navigation. */
export const NAV_LINKS = [
  { href: '/playbooks', label: 'Playbooks' },
  { href: '/calls', label: 'Calls' },
  { href: '/latency', label: 'Latency' },
] as const;

/** A nav link is active on its own page and every page under it (/calls/123 → Calls). */
export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
