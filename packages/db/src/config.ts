import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Load the repo-root .env into process.env if it exists. Real env vars win. */
export function loadRootEnvFile(): void {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  } catch {
    // No .env file: use the real environment only.
  }
}

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

const TestDbEnvSchema = z.object({
  TEST_DATABASE_URL: z
    .url({ error: 'TEST_DATABASE_URL is required to run the db integration tests' })
    .refine((u) => u.startsWith('postgres://') || u.startsWith('postgresql://'), {
      message: 'TEST_DATABASE_URL must be a postgres:// or postgresql:// URL',
    }),
});

/**
 * Admin connection used by the integration tests to create and drop throwaway
 * databases. It must point at a server where the user may CREATE DATABASE.
 */
export function loadTestDbConfig(env: Record<string, string | undefined> = process.env): DbConfig {
  const parsed = TestDbEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid @cue/db test env (is docker compose up, and is .env copied from .env.example?):\n${z.prettifyError(parsed.error)}`,
    );
  }
  return { databaseUrl: parsed.data.TEST_DATABASE_URL };
}

/** The only place @cue/db reads env. Throws with a readable message if invalid. */
export function loadDbConfig(env: Record<string, string | undefined> = process.env): DbConfig {
  const parsed = DbEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid @cue/db env:\n${z.prettifyError(parsed.error)}`);
  }
  return { databaseUrl: parsed.data.DATABASE_URL };
}
