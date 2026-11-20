import { beforeEach, describe, expect, it, vi } from 'vitest';

type DbUser = { id: string; email: string; name: string | null } | null;

const h = vi.hoisted(() => ({
  session: null as { user: { id: string; login?: string } } | null,
  allowed: null as string[] | null,
  dbUser: null as DbUser, // set in beforeEach
}));

vi.mock('@/auth', () => ({ auth: () => Promise.resolve(h.session) }));
vi.mock('@/config', () => ({ serverConfig: () => ({ allowedGithubLogins: h.allowed }) }));
vi.mock('@/server/db', () => ({ getDb: () => ({}) }));
vi.mock('@cue/db', () => ({ getSessionUser: () => Promise.resolve(h.dbUser) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

const { getAccess, getCurrentUser, requireUser } = await import('./session');

const USER = { id: 'u1', email: 'rep@test.local', name: 'Rep' };

beforeEach(() => {
  h.session = { user: { id: 'u1', login: 'octocat' } };
  h.allowed = null;
  h.dbUser = USER;
});

describe('getAccess / requireUser', () => {
  it('lets any signed-in user in when ALLOWED_GITHUB_LOGINS is unset', async () => {
    expect(await getAccess()).toEqual({ kind: 'ok', user: USER });
    expect(await requireUser()).toEqual(USER);
  });

  it('sends a signed-out visitor to /signin', async () => {
    h.session = null;
    expect(await getAccess()).toEqual({ kind: 'signed_out' });
    await expect(requireUser()).rejects.toThrow('redirect:/signin');
  });

  it('treats a valid cookie for a deleted user as signed out', async () => {
    h.dbUser = null;
    await expect(requireUser()).rejects.toThrow('redirect:/signin');
  });

  it('lets a listed login in, ignoring case', async () => {
    h.allowed = ['octocat'];
    h.session = { user: { id: 'u1', login: 'OctoCat' } };
    expect(await requireUser()).toEqual(USER);
  });

  it('sends a login that is not on the list to /invite-only, with no user', async () => {
    h.allowed = ['someone-else'];
    expect(await getAccess()).toEqual({ kind: 'not_invited' });
    expect(await getCurrentUser()).toBeNull(); // so the audio route answers 401
    await expect(requireUser()).rejects.toThrow('redirect:/invite-only');
  });

  it('refuses a session from before logins were recorded once a list is set', async () => {
    h.allowed = ['octocat'];
    h.session = { user: { id: 'u1' } };
    await expect(requireUser()).rejects.toThrow('redirect:/invite-only');
  });
});
