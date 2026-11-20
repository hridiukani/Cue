import { z } from 'zod';

/**
 * DATABASE_POOL_MAX: the most Postgres connections one process may open.
 * Unset (or empty) means the driver's default (10).
 *
 * Why it exists: Supabase's Session pooler gives every client connection its
 * own Postgres connection, up to the project's pool size (often 15). Each
 * Vercel function instance is its own process with its own pool, so the web
 * app runs with 1 and the realtime server with a few (docs/deploy.md).
 */
export const DatabasePoolMaxSchema: z.ZodType<number | undefined, string | undefined> = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v.trim() === '') return undefined;
    const n = Number(v.trim());
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      ctx.addIssue({ code: 'custom', message: 'must be a whole number from 1 to 100' });
      return z.NEVER;
    }
    return n;
  });
