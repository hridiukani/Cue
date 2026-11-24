import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNED_IN_PATH, isPublicPath, safeRedirectPath } from './paths';

describe('isPublicPath', () => {
  it('only treats the landing, sign-in and invite-only pages as public', () => {
    expect(isPublicPath('/')).toBe(true);
    expect(isPublicPath('/signin')).toBe(true);
    expect(isPublicPath('/invite-only')).toBe(true);
    expect(isPublicPath('/playbooks')).toBe(false);
    expect(isPublicPath('/signinx')).toBe(false);
  });

  it('makes "/" public as an exact path only, never as a prefix', () => {
    for (const p of ['/calls', '/latency', '/playbooks/new', '/api/recordings/x/audio', '//x']) {
      expect(isPublicPath(p)).toBe(false);
    }
  });

  it('lands a sign-in on the call library by default', () => {
    expect(DEFAULT_SIGNED_IN_PATH).toBe('/calls');
    expect(safeRedirectPath('/')).toBe('/calls'); // the landing page isn't a destination
  });
});

describe('safeRedirectPath', () => {
  it('keeps same-site relative paths', () => {
    expect(safeRedirectPath('/playbooks/new')).toBe('/playbooks/new');
    expect(safeRedirectPath('/playbooks?x=1')).toBe('/playbooks?x=1');
  });

  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'playbooks',
    '/signin',
    undefined,
    ['/a'],
  ])('falls back to the default for %s', (value) => {
    expect(safeRedirectPath(value)).toBe(DEFAULT_SIGNED_IN_PATH);
  });
});
