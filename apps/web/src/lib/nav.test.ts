import { describe, expect, it } from 'vitest';
import { isNavActive, NAV_LINKS } from './nav';

describe('isNavActive', () => {
  it('is active on the page itself and the pages under it', () => {
    expect(isNavActive('/calls', '/calls')).toBe(true);
    expect(isNavActive('/calls/0b6f1c3e-0000-4000-8000-000000000000', '/calls')).toBe(true);
    expect(isNavActive('/playbooks/new', '/playbooks')).toBe(true);
  });

  it('is not fooled by a shared prefix', () => {
    expect(isNavActive('/callsx', '/calls')).toBe(false);
    expect(isNavActive('/latency', '/calls')).toBe(false);
  });

  it('has exactly one active link on each app page', () => {
    for (const path of ['/playbooks', '/calls/abc', '/latency']) {
      expect(NAV_LINKS.filter((l) => isNavActive(path, l.href))).toHaveLength(1);
    }
  });
});
