import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDbConfig } from '@cue/db';
import { z } from 'zod';

const EnvSchema = z.object({
  // Optional: only needed for gated or private datasets.
  HF_TOKEN: z.string().min(1).optional(),
  BLOB_STORE_DIR: z.string().min(1).optional(),
});

export interface IngestConfig {
  databaseUrl: string;
  hfToken: string | undefined;
  blobStoreDir: string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The only place @cue/ingest reads env. */
export function loadIngestConfig(
  env: Record<string, string | undefined> = process.env,
): IngestConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid @cue/ingest env:\n${z.prettifyError(parsed.error)}`);
  }
  return {
    databaseUrl: loadDbConfig(env).databaseUrl,
    hfToken: parsed.data.HF_TOKEN,
    blobStoreDir: parsed.data.BLOB_STORE_DIR ?? path.join(repoRoot, 'data', 'blobs'),
  };
}
