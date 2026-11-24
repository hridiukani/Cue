import 'server-only';
import path from 'node:path';
import { type BlobStore, LocalFsBlobStore } from '@cue/storage';
import { serverConfig } from '@/config';

const globalForBlobs = globalThis as unknown as { cueBlobs?: BlobStore };

/** False when AUDIO_PLAYBACK=off (deployments): no recording audio is served at all. */
export function audioPlaybackEnabled(): boolean {
  return serverConfig().audioPlayback;
}

/**
 * The store `pnpm ingest --with-audio` wrote recordings' audio into.
 * Default: the repo's ./data/blobs. `pnpm dev` runs Next from apps/web, so
 * that's two folders up from the working directory. (node:path, not
 * `new URL(…, import.meta.url)`: the bundler would copy the target into the build.)
 * Set BLOB_STORE_DIR when running from anywhere else.
 */
export function getBlobStore(): BlobStore {
  globalForBlobs.cueBlobs ??= new LocalFsBlobStore(
    serverConfig().blobStoreDir ??
      // turbopackIgnore: a runtime folder, not a build input. Without it the
      // bundler traces this path and reads every recording's audio (real-sales
      // WAVs, no license) into the build. next.config.ts also excludes data/.
      path.resolve(/* turbopackIgnore: true */ process.cwd(), '..', '..', 'data', 'blobs'),
  );
  return globalForBlobs.cueBlobs;
}
