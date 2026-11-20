import { z } from 'zod';

/**
 * Invite-only access (ALLOWED_GITHUB_LOGINS).
 *
 * GitHub sign-in is open to anyone with a GitHub account, so a public
 * deployment can set a comma-separated list of GitHub logins. Unset means
 * anyone who signs in may use the app (as before). Checked twice:
 * - at sign-in (auth.ts): anyone else is sent to /invite-only and no Cue user
 *   is created;
 * - on every request (server/session.ts): removing a login from the list
 *   takes effect at once, even with a valid session cookie.
 */

export const INVITE_ONLY_PATH = '/invite-only';

// GitHub's rule: 1-39 characters, letters, digits and single hyphens, not at either end.
const GitHubLogin = z
  .string()
  .regex(/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i, 'not a valid GitHub login');

/** Logins are case-insensitive on GitHub, so compare lowercased. */
export const AllowedGithubLoginsSchema: z.ZodType<string[] | null, string | undefined> = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v.trim() === '') return null;
    const logins = v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const out: string[] = [];
    for (const login of logins) {
      const parsed = GitHubLogin.safeParse(login);
      if (!parsed.success) {
        ctx.addIssue({ code: 'custom', message: `"${login}" is not a valid GitHub login` });
        return z.NEVER;
      }
      out.push(login.toLowerCase());
    }
    return out.length > 0 ? out : null;
  });

/** null = no list: everyone who signs in is allowed. */
export function isLoginAllowed(
  login: string | null | undefined,
  allowed: readonly string[] | null,
): boolean {
  if (allowed === null) return true;
  if (!login) return false; // a list is set but we don't know who this is
  return allowed.includes(login.toLowerCase());
}

/** The GitHub login from the OAuth profile, if it has a valid one. */
export function githubLoginFrom(profile: unknown): string | null {
  const parsed = z.object({ login: GitHubLogin }).safeParse(profile);
  return parsed.success ? parsed.data.login : null;
}
