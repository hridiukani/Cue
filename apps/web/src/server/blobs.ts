import 'server-only';
import path from 'node:path';
import { type BlobStore, LocalFsBlobStore } from '@cue/storage';
import { serverConfig } from '@/config';

const globalForBlobs = globalThis as unknown as { cueBlobs?: BlobStore };

/**
 * The store `pnpm ingest --with-audio` wrote recordings' audio into.
 * Default: the repo's ./data/blobs. `pnpm dev` runs Next from apps/web, so
 * that's two folders up from the working directory. (node:path, not
 * `new URL(…, import.meta.url)`: the bundler would copy the target into the build.)
 * Set BLOB_STORE_DIR when running from anywhere else.
 */
export function getBlobStore(): BlobStore {
  globalForBlobs.cueBlobs ??= new LocalFsBlobStore(
    serverConfig().blobStoreDir ?? path.resolve(process.cwd(), '..', '..', 'data', 'blobs'),
  );
  return globalForBlobs.cueBlobs;
}
