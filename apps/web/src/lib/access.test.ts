import { describe, expect, it } from 'vitest';
import { AllowedGithubLoginsSchema, githubLoginFrom, isLoginAllowed } from './access';

describe('AllowedGithubLoginsSchema', () => {
  it('means "everyone" when unset or empty', () => {
    expect(AllowedGithubLoginsSchema.parse(undefined)).toBeNull();
    expect(AllowedGithubLoginsSchema.parse('')).toBeNull();
    expect(AllowedGithubLoginsSchema.parse(' , ')).toBeNull();
  });

  it('reads a comma-separated list, trimmed and lowercased', () => {
    expect(AllowedGithubLoginsSchema.parse(' Octocat, hubot ,a-b ')).toEqual([
      'octocat',
      'hubot',
      'a-b',
    ]);
  });

  it.each(['-bad', 'bad-', 'two--hyphens', 'has space', 'x'.repeat(40), 'a@b'])(
    'rejects the invalid login %j',
    (login) => {
      const r = AllowedGithubLoginsSchema.safeParse(`octocat,${login}`);
      expect(r.success).toBe(false);
    },
  );
});

describe('isLoginAllowed', () => {
  it('allows everyone when there is no list', () => {
    expect(isLoginAllowed('anyone', null)).toBe(true);
    expect(isLoginAllowed(undefined, null)).toBe(true);
  });

  it('allows only listed logins, ignoring case', () => {
    expect(isLoginAllowed('OctoCat', ['octocat'])).toBe(true);
    expect(isLoginAllowed('mallory', ['octocat'])).toBe(false);
  });

  it('refuses an unknown login when a list is set (e.g. a session from before the list)', () => {
    expect(isLoginAllowed(undefined, ['octocat'])).toBe(false);
    expect(isLoginAllowed(null, ['octocat'])).toBe(false);
    expect(isLoginAllowed('', ['octocat'])).toBe(false);
  });
});

describe('githubLoginFrom', () => {
  it('reads the login from a GitHub profile', () => {
    expect(githubLoginFrom({ login: 'octocat', id: 1 })).toBe('octocat');
  });

  it.each([undefined, null, {}, { login: 42 }, { login: '-x' }])('is null for %j', (profile) => {
    expect(githubLoginFrom(profile)).toBeNull();
  });
});
