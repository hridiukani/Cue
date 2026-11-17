import { z } from 'zod';

const PublicEnvSchema = z.object({
  NEXT_PUBLIC_REALTIME_URL: z
    .url()
    .refine((u) => u.startsWith('ws://') || u.startsWith('wss://'), {
      message: 'NEXT_PUBLIC_REALTIME_URL must be a ws:// or wss:// URL',
    })
    .default('ws://localhost:4000'),
});

export interface PublicConfig {
  realtimeUrl: string;
}

export function parsePublicConfig(env: Record<string, string | undefined>): PublicConfig {
  const parsed = PublicEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid apps/web env:\n${z.prettifyError(parsed.error)}`);
  }
  return { realtimeUrl: parsed.data.NEXT_PUBLIC_REALTIME_URL };
}

/**
 * The only place apps/web reads env. NEXT_PUBLIC_* vars must be referenced
 * literally so Next can inline them into the client bundle.
 */
export const publicConfig: PublicConfig = parsePublicConfig({
  NEXT_PUBLIC_REALTIME_URL: process.env.NEXT_PUBLIC_REALTIME_URL,
});

const postgresUrl = z
  .url()
  .refine((u) => u.startsWith('postgres://') || u.startsWith('postgresql://'), {
    message: 'must be a postgres:// or postgresql:// URL',
  });

const ServerEnvSchema = z.object({
  DATABASE_URL: postgresUrl,
  // Signs and encrypts session cookies. Generate with: npx auth secret
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  AUTH_GITHUB_ID: z.string().min(1, 'AUTH_GITHUB_ID is required (GitHub OAuth app client id)'),
  AUTH_GITHUB_SECRET: z.string().min(1, 'AUTH_GITHUB_SECRET is required'),
});

export interface ServerConfig {
  databaseUrl: string;
  authSecret: string;
  githubClientId: string;
  githubClientSecret: string;
}

export function parseServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const parsed = ServerEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid apps/web server env:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    authSecret: e.AUTH_SECRET,
    githubClientId: e.AUTH_GITHUB_ID,
    githubClientSecret: e.AUTH_GITHUB_SECRET,
  };
}

let cachedServerConfig: ServerConfig | undefined;

/**
 * Server-only secrets, parsed on first use. Lazy on purpose: this module is
 * also imported by client components (for publicConfig), where these vars
 * don't exist, and `next build` shouldn't need secrets just to compile.
 */
export function serverConfig(): ServerConfig {
  cachedServerConfig ??= parseServerConfig(process.env);
  return cachedServerConfig;
}
