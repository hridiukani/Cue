import { fileURLToPath } from 'node:url';
import { DatabasePoolMaxSchema } from '@cue/shared';
import { z } from 'zod';

const postgresUrl = z
  .url()
  .refine((u) => u.startsWith('postgres://') || u.startsWith('postgresql://'), {
    message: 'must be a postgres:// or postgresql:// URL',
  });

// An empty value (e.g. 'GROQ_API_KEY=' copied from .env.example) means "not set".
const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  REALTIME_HOST: z.string().min(1).default('localhost'),
  REALTIME_PORT: z.coerce.number().int().min(0).max(65_535).optional(),
  // Set by hosts like Render (the port they route traffic to). REALTIME_PORT wins if both are set.
  PORT: z.coerce.number().int().min(0).max(65_535).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: postgresUrl,
  DATABASE_POOL_MAX: DatabasePoolMaxSchema,
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
  // Suggestions (optional: without a key they're disabled and the browser is told so).
  GROQ_API_KEY: optionalSecret,
  // gpt-oss-20b: llama-3.1-8b-instant returned model_not_found for our Groq account (2026-11-17).
  GROQ_MODEL: z.string().min(1).default('openai/gpt-oss-20b'),
  GROQ_BASE_URL: z.url().default('https://api.groq.com/openai/v1'),
  SUGGESTION_FIRST_TOKEN_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(1500),
  SUGGESTION_TOTAL_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(5000),
});

type Env = z.infer<typeof EnvSchema>;

export interface RealtimeConfig {
  nodeEnv: Env['NODE_ENV'];
  host: string;
  port: number;
  logLevel: Env['LOG_LEVEL'];
  databaseUrl: string;
  /** Undefined = the driver's default. */
  databasePoolMax: number | undefined;
  ticketSecret: string;
  allowedOrigins: string[];
  groq: { apiKey: string | undefined; model: string; baseUrl: string };
  suggestions: { firstTokenTimeoutMs: number; totalTimeoutMs: number };
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
    port: e.REALTIME_PORT ?? e.PORT ?? 4000,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    databasePoolMax: e.DATABASE_POOL_MAX,
    ticketSecret: e.REALTIME_TICKET_SECRET,
    allowedOrigins: e.REALTIME_ALLOWED_ORIGINS,
    groq: { apiKey: e.GROQ_API_KEY, model: e.GROQ_MODEL, baseUrl: e.GROQ_BASE_URL },
    suggestions: {
      firstTokenTimeoutMs: e.SUGGESTION_FIRST_TOKEN_TIMEOUT_MS,
      totalTimeoutMs: e.SUGGESTION_TOTAL_TIMEOUT_MS,
    },
  };
}
