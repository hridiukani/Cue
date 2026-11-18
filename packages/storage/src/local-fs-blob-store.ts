import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  assertValidKey,
  BlobNotFoundError,
  type BlobStore,
  type ByteRange,
  type PutResult,
} from './blob-store';

/** BlobStore backed by a local folder (default for development: ./data/blobs). */
export class LocalFsBlobStore implements BlobStore {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  private pathFor(key: string): string {
    assertValidKey(key);
    const full = path.resolve(this.root, ...key.split('/'));
    // Belt and braces: the key check already prevents this.
    if (!full.startsWith(this.root + path.sep)) throw new Error('blob path escaped root');
    return full;
  }

  async put(key: string, body: Readable | Uint8Array): Promise<PutResult> {
    const target = this.pathFor(key);
    await mkdir(path.dirname(target), { recursive: true });
    // Write to a temp file in the same folder, then rename: readers never see
    // a half-written blob, and a failed download leaves nothing behind.
    const temp = `${target}.${randomUUID()}.partial`;
    const hash = createHash('sha256');
    let bytes = 0;
    const measure = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        bytes += chunk.length;
        done(null, chunk);
      },
    });
    const source = body instanceof Readable ? body : Readable.from([Buffer.from(body)]);
    try {
      await pipeline(source, measure, createWriteStream(temp));
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
    return { bytes, sha256: hash.digest('hex') };
  }

  async get(key: string, range?: ByteRange): Promise<Readable> {
    const file = this.pathFor(key);
    const info = await this.head(key);
    if (!info) throw new BlobNotFoundError(key);
    if (!range) return createReadStream(file);
    const { start, end } = range;
    const valid =
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start >= 0 &&
      start <= end &&
      end < info.bytes;
    if (!valid) {
      throw new RangeError(
        `bytes ${String(start)}-${String(end)} outside blob of ${String(info.bytes)}`,
      );
    }
    return createReadStream(file, { start, end });
  }

  async head(key: string): Promise<{ bytes: number } | null> {
    try {
      const s = await stat(this.pathFor(key));
      return s.isFile() ? { bytes: s.size } : null;
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
