import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  session: null as { user: { id: string } } | null,
  authThrows: false,
}));

// The landing page may read the session cookie, and nothing else: no database.
vi.mock('@/auth', () => ({
  auth: () => (h.authThrows ? Promise.reject(new Error('down')) : Promise.resolve(h.session)),
}));
vi.mock('@/server/db', () => ({
  getDb: () => {
    throw new Error('the landing page must not touch the database');
  },
}));

const { default: LandingPage } = await import('./page');

const render = async () => renderToStaticMarkup(await LandingPage());

beforeEach(() => {
  h.session = null;
  h.authThrows = false;
});

describe('landing page', () => {
  it('invites a signed-out visitor to sign in', async () => {
    const html = await render();
    expect(html).toContain('The next line, before the silence gets awkward.');
    expect(html).toContain('href="/signin"');
    expect(html).toContain('Sign in with GitHub →');
    expect(html).not.toContain('Open Cue');
  });

  it('sends a signed-in visitor into the app (the call library)', async () => {
    h.session = { user: { id: 'u1' } };
    const html = await render();
    expect(html).toContain('Open Cue →');
    expect(html).toContain('href="/calls"');
  });

  it('still renders when the session check fails (e.g. a bad cookie)', async () => {
    h.authThrows = true;
    expect(await render()).toContain('Sign in with GitHub →');
  });

  it('quotes the measured numbers with their caveat', async () => {
    const html = await render();
    for (const n of ['325', '671', '909', '185']) expect(html).toContain(n);
    expect(html).toContain('don&#x27;t include it');
  });
});
