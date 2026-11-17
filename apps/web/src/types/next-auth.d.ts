import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    // The Cue user id (users.id), set in the session callback in auth.ts.
    user: { id: string } & DefaultSession['user'];
  }
}
