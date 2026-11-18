import type { Readable } from 'node:stream';

/**
 * Where imported files (e.g. call audio) live. Callers only see keys like
 * "real-sales/conversation-1.wav", never paths or buckets, so a local folder
 * can be swapped for S3-compatible storage without touching callers.
 */
export interface BlobStore {
  /** Write a blob atomically (all or nothing). Returns its size and SHA-256. */
  put(key: string, body: Readable | Uint8Array): Promise<PutResult>;
  /**
   * Stream a blob, or only bytes `start..end` (both inclusive, like an HTTP
   * Range). Throws BlobNotFoundError if it doesn't exist, and RangeError if
   * the range isn't inside the blob.
   */
  get(key: string, range?: ByteRange): Promise<Readable>;
  /** Size of a blob, or null if it doesn't exist. */
  head(key: string): Promise<{ bytes: number } | null>;
  /** Delete a blob. Deleting a missing blob is not an error. */
  delete(key: string): Promise<void>;
}

/** An inclusive byte range: `{ start: 0, end: 0 }` is the first byte. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface PutResult {
  bytes: number;
  sha256: string;
}

export class BlobNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`Blob not found: ${key}`);
    this.name = 'BlobNotFoundError';
  }
}

export class InvalidBlobKeyError extends Error {
  constructor(readonly key: string) {
    super(`Invalid blob key: ${JSON.stringify(key)}`);
    this.name = 'InvalidBlobKeyError';
  }
}

/**
 * Keys are relative, slash-separated, and made of safe characters only. This
 * rules out "../", absolute paths and backslashes, so a key can never escape
 * the store's root (path traversal), whichever backend is used.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertValidKey(key: string): void {
  const segments = key.split('/');
  const ok =
    key.length > 0 &&
    key.length <= 512 &&
    segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..');
  if (!ok) throw new InvalidBlobKeyError(key);
}
