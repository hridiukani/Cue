import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, type Db, upsertDataset, upsertRecording, upsertRecordingAudio } from '@cue/db';
import { LocalFsBlobStore } from '@cue/storage';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import type { CurrentUser } from '@/server/session';

/**
 * The audio route end to end: real route handler, real repository, real
 * (throwaway) Postgres, real files on disk. Only the signed-in user is faked.
 */

const h = vi.hoisted(() => ({
  db: undefined as Db | undefined,
  blobs: undefined as LocalFsBlobStore | undefined,
  signedInAs: null as CurrentUser | null,
  audioOn: true,
}));

vi.mock('@/server/db', () => ({
  getDb: () => {
    if (!h.db) throw new Error('test db not ready');
    return h.db;
  },
}));
vi.mock('@/server/blobs', () => ({
  audioPlaybackEnabled: () => h.audioOn,
  getBlobStore: () => {
    if (!h.blobs) throw new Error('test blob store not ready');
    return h.blobs;
  },
}));
vi.mock('@/server/session', () => ({
  getCurrentUser: () => Promise.resolve(h.signedInAs),
}));

const { GET, HEAD } = await import('@/app/api/recordings/[id]/audio/route');

/** 256 bytes whose value is their own offset, so any slice is easy to check. */
const AUDIO = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const SIZE = AUDIO.length;

let close: () => Promise<void>;
let blobDir: string;
let withAudio: string; // recording with an audio file
let transcriptOnly: string; // recording without stored audio
let missingFile: string; // audio row, but the file is gone

beforeAll(async () => {
  const conn = createDb(inject('testDatabaseUrl'));
  h.db = conn.db;
  close = conn.close;
  blobDir = await mkdtemp(path.join(tmpdir(), 'cue-audio-route-'));
  h.blobs = new LocalFsBlobStore(blobDir);

  const datasetId = `test/${randomUUID()}`;
  await upsertDataset(conn.db, {
    id: datasetId,
    name: 'D',
    url: 'u',
    license: 'unspecified',
    revision: null,
  });
  const rec = (externalId: string) =>
    upsertRecording(conn.db, {
      datasetId,
      externalId,
      title: externalId,
      timing: 'real',
      hasAudio: false,
      language: 'en',
      metadata: {},
      utterances: [{ speaker: 'rep', text: 'hello', startedMs: 0, endedMs: 1000 }],
    });
  const audioRow = (recordingId: string, storageKey: string) =>
    upsertRecordingAudio(conn.db, {
      recordingId,
      storageKey,
      contentType: 'audio/wav',
      bytes: SIZE,
      sampleRate: 48000,
      channels: 2,
      durationMs: 1000,
      sha256: 'a'.repeat(64),
    });

  withAudio = await rec('with-audio');
  await h.blobs.put(`test/${withAudio}.wav`, AUDIO);
  await audioRow(withAudio, `test/${withAudio}.wav`);
  transcriptOnly = await rec('transcript-only');
  missingFile = await rec('missing-file');
  await audioRow(missingFile, `test/${missingFile}.wav`);
});

afterAll(async () => {
  await close();
  await rm(blobDir, { recursive: true, force: true });
});

beforeEach(() => {
  h.signedInAs = { id: randomUUID(), email: 'rep@test.local', name: 'Rep' };
  h.audioOn = true;
});

function get(id: string, headers: Record<string, string> = {}) {
  const req = new Request(`http://localhost/api/recordings/${id}/audio`, { headers });
  return GET(req, { params: Promise.resolve({ id }) });
}

async function bytes(res: Response): Promise<number[]> {
  return [...new Uint8Array(await res.arrayBuffer())];
}

const slice = (start: number, end: number) => [...AUDIO.subarray(start, end + 1)];

describe('GET /api/recordings/:id/audio', () => {
  it('refuses signed-out requests with 401 and streams nothing', async () => {
    h.signedInAs = null;
    const res = await get(withAudio, { range: 'bytes=0-9' });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('serves no audio at all when playback is off (AUDIO_PLAYBACK=off, deployments)', async () => {
    h.audioOn = false;
    const res = await get(withAudio, { range: 'bytes=0-9' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    h.signedInAs = null;
    expect((await get(withAudio)).status).toBe(401); // signed out is still told to sign in
  });

  it('serves the whole file without a Range header and advertises range support', async () => {
    const res = await get(withAudio);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('content-length')).toBe(String(SIZE));
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-range')).toBeNull();
    expect(await bytes(res)).toEqual(slice(0, SIZE - 1));
  });

  it.each([
    ['bytes=0-0', 0, 0],
    ['bytes=10-19', 10, 19],
    ['bytes=200-', 200, SIZE - 1], // what <audio> sends when seeking
    ['bytes=-16', SIZE - 16, SIZE - 1],
    ['bytes=250-9999', 250, SIZE - 1], // clamped
  ])('%s → 206 with exactly bytes %i-%i', async (range, start, end) => {
    const res = await get(withAudio, { range });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(
      `bytes ${String(start)}-${String(end)}/${String(SIZE)}`,
    );
    expect(res.headers.get('content-length')).toBe(String(end - start + 1));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await bytes(res)).toEqual(slice(start, end));
  });

  it('answers a range past the end with 416 and the real size', async () => {
    const res = await get(withAudio, { range: `bytes=${String(SIZE)}-` });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${String(SIZE)}`);
    expect(await bytes(res)).toEqual([]);
  });

  it('ignores multi-range and malformed headers and serves the whole file', async () => {
    for (const range of ['bytes=0-1,4-5', 'bytes=9-3', 'pages=1-2']) {
      const res = await get(withAudio, { range });
      expect(res.status).toBe(200);
      expect(await bytes(res)).toHaveLength(SIZE);
    }
  });

  it('is the same 404 for an unknown id, a non-uuid, no stored audio, and a missing file', async () => {
    for (const id of [randomUUID(), 'not-a-uuid', transcriptOnly, missingFile]) {
      const res = await get(id, { range: 'bytes=0-' });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
  });

  it('answers HEAD with the headers and no body', async () => {
    const req = new Request(`http://localhost/api/recordings/${withAudio}/audio`, {
      method: 'HEAD',
      headers: { range: 'bytes=0-99' },
    });
    const res = await HEAD(req, { params: Promise.resolve({ id: withAudio }) });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-length')).toBe('100');
    expect(res.body).toBeNull();
  });
});
