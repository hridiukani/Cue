import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import robots from '@/app/robots';

/**
 * Signed-out visitors (anyone on the internet, once deployed) must not reach
 * the call library, transcripts or audio. These check the first gate, the
 * proxy; pages, server actions and the audio route check again themselves
 * (requireUser / getCurrentUser, tested elsewhere).
 */

beforeAll(() => {
  vi.stubEnv('DATABASE_URL', 'postgres://u:p@localhost:5434/cue');
  vi.stubEnv('AUTH_SECRET', 'x'.repeat(32));
  vi.stubEnv('AUTH_GITHUB_ID', 'id');
  vi.stubEnv('AUTH_GITHUB_SECRET', 'secret');
  vi.stubEnv('REALTIME_TICKET_SECRET', 't'.repeat(32));
});

async function authorized(pathname: string, signedIn: boolean): Promise<true | Response> {
  const { authConfig } = await import('@/auth.config');
  const cb = authConfig().callbacks?.authorized;
  if (!cb) throw new Error('no authorized callback');
  const request = new NextRequest(`http://localhost${pathname}`);
  const auth = signedIn
    ? { user: { id: 'u1', name: 'Rep' }, expires: '2099-01-01T00:00:00.000Z' }
    : null;
  const result: unknown = await cb({ auth, request });
  if (result === true) return true;
  if (result instanceof Response) return result;
  throw new Error(`unexpected authorized() result: ${String(result)}`);
}

describe('the auth proxy, signed out', () => {
  it.each([
    '/',
    '/calls',
    '/calls/00000000-0000-4000-8000-000000000000',
    '/playbooks',
    '/latency',
    '/api/recordings/00000000-0000-4000-8000-000000000000/audio',
  ])('redirects %s to sign-in', async (pathname) => {
    const r = await authorized(pathname, false);
    expect(r).toBeInstanceOf(Response);
    const location = (r as Response).headers.get('location') ?? '';
    expect(new URL(location).pathname).toBe('/signin');
  });

  it('lets the sign-in page through', async () => {
    expect(await authorized('/signin', false)).toBe(true);
  });

  it('lets a signed-in user through', async () => {
    expect(await authorized('/calls', true)).toBe(true);
  });
});

describe('what the proxy runs on (src/proxy.ts matcher)', () => {
  // The matcher must stay a literal in proxy.ts (Next reads it at build time),
  // so read it from the source and check it the way Next applies it.
  const source = readFileSync(path.join(import.meta.dirname, 'proxy.ts'), 'utf8');
  const literal = /matcher:\s*\['([^']+)'\]/.exec(source)?.[1];
  const matches = (pathname: string) => new RegExp(`^${literal ?? 'missing'}$`).test(pathname);

  it('covers the app, the call library and the audio route', () => {
    expect(literal).toBeDefined();
    for (const p of ['/', '/calls', '/latency', '/api/recordings/x/audio']) {
      expect(matches(p)).toBe(true);
    }
  });

  it("skips Auth.js's own routes, static assets and robots.txt", () => {
    for (const p of ['/api/auth/signin', '/_next/static/x.js', '/favicon.ico', '/robots.txt']) {
      expect(matches(p)).toBe(false);
    }
  });
});

describe('robots.txt', () => {
  it('disallows everything', () => {
    expect(robots()).toEqual({ rules: { userAgent: '*', disallow: '/' } });
  });
});

describe('X-Robots-Tag', () => {
  it('marks every response noindex', async () => {
    const { default: nextConfig } = await import('../next.config');
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules).toEqual([
      { source: '/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
    ]);
  });
});

describe('build tracing', () => {
  it('never traces imported recordings (data/, audio files) into a build', async () => {
    const { default: nextConfig } = await import('../next.config');
    expect(nextConfig.outputFileTracingExcludes?.['*']).toEqual(
      expect.arrayContaining(['../../data/**', '**/*.wav']),
    );
  });
});
