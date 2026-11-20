import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    // The Cue user id (users.id) and the GitHub login (for ALLOWED_GITHUB_LOGINS),
    // set in the session callback in auth.ts. login is undefined for sessions
    // from before it was recorded.
    user: { id: string; login?: string } & DefaultSession['user'];
  }
}
