import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const postgresUrl = z
  .url()
  .refine((u) => u.startsWith('postgres://') || u.startsWith('postgresql://'), {
    message: 'must be a postgres:// or postgresql:// URL',
  });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  REALTIME_HOST: z.string().min(1).default('localhost'),
  REALTIME_PORT: z.coerce.number().int().min(0).max(65_535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: postgresUrl,
  // Shared with apps/web, which signs the WebSocket tickets.
  REALTIME_TICKET_SECRET: z
    .string()
    .min(32, 'REALTIME_TICKET_SECRET must be at least 32 characters'),
  // Browser origins allowed to open the WebSocket (comma-separated).
  REALTIME_ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url()).min(1)),
});

type Env = z.infer<typeof EnvSchema>;

export interface RealtimeConfig {
  nodeEnv: Env['NODE_ENV'];
  host: string;
  port: number;
  logLevel: Env['LOG_LEVEL'];
  databaseUrl: string;
  ticketSecret: string;
  allowedOrigins: string[];
}

/** Load the repo-root .env into process.env if it exists. Real env vars win. */
export function loadEnvFileIfPresent(): void {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  } catch {
    // No .env file: use the real environment only.
  }
}

/** The only place apps/realtime reads env. Throws with a readable message if invalid. */
export function loadConfig(env: Record<string, string | undefined> = process.env): RealtimeConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid apps/realtime env:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    host: e.REALTIME_HOST,
    port: e.REALTIME_PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    ticketSecret: e.REALTIME_TICKET_SECRET,
    allowedOrigins: e.REALTIME_ALLOWED_ORIGINS,
  };
}
