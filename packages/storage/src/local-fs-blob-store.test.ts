import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobNotFoundError, InvalidBlobKeyError } from './blob-store';
import { LocalFsBlobStore } from './local-fs-blob-store';

let dir: string;
let store: LocalFsBlobStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cue-blobs-'));
  store = new LocalFsBlobStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('LocalFsBlobStore', () => {
  it('round-trips bytes and reports size and sha256', async () => {
    const data = Buffer.from('hello audio');
    const result = await store.put('real-sales/conversation-1.wav', data);
    expect(result).toEqual({
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
    expect(await text(await store.get('real-sales/conversation-1.wav'))).toBe('hello audio');
    expect(await store.head('real-sales/conversation-1.wav')).toEqual({ bytes: data.length });
  });

  it('accepts a stream and overwrites an existing key', async () => {
    await store.put('a.txt', Buffer.from('old'));
    await store.put('a.txt', Readable.from([Buffer.from('ne'), Buffer.from('w')]));
    expect(await text(await store.get('a.txt'))).toBe('new');
  });

  it('reports missing blobs', async () => {
    expect(await store.head('missing.wav')).toBeNull();
    await expect(store.get('missing.wav')).rejects.toBeInstanceOf(BlobNotFoundError);
    await store.delete('missing.wav'); // not an error
  });

  it('streams an inclusive byte range', async () => {
    await store.put('r.bin', Buffer.from('0123456789'));
    expect(await text(await store.get('r.bin', { start: 0, end: 0 }))).toBe('0');
    expect(await text(await store.get('r.bin', { start: 3, end: 6 }))).toBe('3456');
    expect(await text(await store.get('r.bin', { start: 9, end: 9 }))).toBe('9');
  });

  it.each([
    { start: 0, end: 10 }, // past the last byte
    { start: 5, end: 4 },
    { start: -1, end: 2 },
    { start: 1.5, end: 2 },
  ])('rejects the range %j', async (range) => {
    await store.put('r.bin', Buffer.from('0123456789'));
    await expect(store.get('r.bin', range)).rejects.toBeInstanceOf(RangeError);
  });

  it('deletes', async () => {
    await store.put('x.bin', Buffer.from([1, 2, 3]));
    await store.delete('x.bin');
    expect(await store.head('x.bin')).toBeNull();
  });

  it.each([
    '../escape.txt',
    'a/../../b',
    '/abs/path',
    'C:\\windows',
    'a//b',
    '',
    '.hidden',
    'a/./b',
  ])('rejects the unsafe key %j', async (key) => {
    await expect(store.put(key, Buffer.from('x'))).rejects.toBeInstanceOf(InvalidBlobKeyError);
  });

  it('leaves no partial file behind when the source stream fails', async () => {
    const failing = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('network dropped'));
      },
    });
    await expect(store.put('dl/big.wav', failing)).rejects.toThrow('network dropped');
    expect(await store.head('dl/big.wav')).toBeNull();
    expect(await readdir(path.join(dir, 'dl'))).toEqual([]);
  });
});
