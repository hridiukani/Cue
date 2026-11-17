import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  REALTIME_HOST: z.string().min(1).default('localhost'),
  REALTIME_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

type Env = z.infer<typeof EnvSchema>;

export interface RealtimeConfig {
  nodeEnv: Env['NODE_ENV'];
  host: string;
  port: number;
  logLevel: Env['LOG_LEVEL'];
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
  };
}
