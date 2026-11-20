import { DatabasePoolMaxSchema } from '@cue/shared';
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
  // Connections per server process; 1 on Vercel (each function instance has its own pool).
  DATABASE_POOL_MAX: DatabasePoolMaxSchema,
  // Signs and encrypts session cookies. Generate with: npx auth secret
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  AUTH_GITHUB_ID: z.string().min(1, 'AUTH_GITHUB_ID is required (GitHub OAuth app client id)'),
  AUTH_GITHUB_SECRET: z.string().min(1, 'AUTH_GITHUB_SECRET is required'),
  // Signs the short-lived tickets the browser uses to open the realtime WebSocket.
  REALTIME_TICKET_SECRET: z
    .string()
    .min(32, 'REALTIME_TICKET_SECRET must be at least 32 characters'),
  // "off" in deployments: no recording audio is hosted (real-sales WAVs have no
  // stated license). The audio route then always 404s and the page says so.
  AUDIO_PLAYBACK: z.enum(['on', 'off']).default('on'),
  // Where `pnpm ingest --with-audio` stored recordings' audio. Empty = the default.
  BLOB_STORE_DIR: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim())),
});

export interface ServerConfig {
  databaseUrl: string;
  /** Undefined = the driver's default. */
  databasePoolMax: number | undefined;
  authSecret: string;
  githubClientId: string;
  githubClientSecret: string;
  realtimeTicketSecret: string;
  /** False when AUDIO_PLAYBACK=off: recordings' audio is never served. */
  audioPlayback: boolean;
  /** Unset means the repo's ./data/blobs (resolved in server/blobs.ts, not here: this file is also client code). */
  blobStoreDir: string | undefined;
}

export function parseServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const parsed = ServerEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid apps/web server env:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    databasePoolMax: e.DATABASE_POOL_MAX,
    authSecret: e.AUTH_SECRET,
    githubClientId: e.AUTH_GITHUB_ID,
    githubClientSecret: e.AUTH_GITHUB_SECRET,
    realtimeTicketSecret: e.REALTIME_TICKET_SECRET,
    audioPlayback: e.AUDIO_PLAYBACK === 'on',
    blobStoreDir: e.BLOB_STORE_DIR,
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
