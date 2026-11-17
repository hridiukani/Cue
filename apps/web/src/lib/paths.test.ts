import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNED_IN_PATH, isPublicPath, safeRedirectPath } from './paths';

describe('isPublicPath', () => {
  it('only treats the sign-in page as public', () => {
    expect(isPublicPath('/signin')).toBe(true);
    expect(isPublicPath('/playbooks')).toBe(false);
    expect(isPublicPath('/')).toBe(false);
    expect(isPublicPath('/signinx')).toBe(false);
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
