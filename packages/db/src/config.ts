import { z } from 'zod';

const DbEnvSchema = z.object({
  DATABASE_URL: z
    .url()
    .refine((u) => u.startsWith('postgres://') || u.startsWith('postgresql://'), {
      message: 'DATABASE_URL must be a postgres:// or postgresql:// URL',
    }),
});

export interface DbConfig {
  databaseUrl: string;
}

/** The only place @cue/db reads env. Throws with a readable message if invalid. */
export function loadDbConfig(env: Record<string, string | undefined> = process.env): DbConfig {
  const parsed = DbEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid @cue/db env:\n${z.prettifyError(parsed.error)}`);
  }
  return { databaseUrl: parsed.data.DATABASE_URL };
}
