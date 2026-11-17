import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadIngestConfig } from './config';

const DB = { DATABASE_URL: 'postgres://cue:cue@localhost:5434/cue' };

describe('loadIngestConfig', () => {
  it('treats an empty HF_TOKEN (as copied from .env.example) as unset', () => {
    expect(loadIngestConfig({ ...DB, HF_TOKEN: '' }).hfToken).toBeUndefined();
    expect(loadIngestConfig({ ...DB, HF_TOKEN: '  ' }).hfToken).toBeUndefined();
  });

  it('reads a token and a custom blob directory', () => {
    const c = loadIngestConfig({ ...DB, HF_TOKEN: 'hf_x', BLOB_STORE_DIR: '/tmp/blobs' });
    expect(c).toMatchObject({ hfToken: 'hf_x', blobStoreDir: '/tmp/blobs' });
  });

  it('defaults blob storage to <repo>/data/blobs', () => {
    expect(loadIngestConfig(DB).blobStoreDir.endsWith(path.join('data', 'blobs'))).toBe(true);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadIngestConfig({})).toThrow(/DATABASE_URL/);
  });
});
