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
