import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, type Db, getRecordingUtterances, listRecordings, schema } from '@cue/db';
import { LocalFsBlobStore } from '@cue/storage';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { realSalesAdapter } from '../src/adapters/real-sales';
import { saasAdapter } from '../src/adapters/saas';
import { HfClient } from '../src/hf-client';
import type { FetchFn } from '../src/http';
import { runIngest } from '../src/run';
import type { DatasetAdapter } from '../src/types';

/**
 * End-to-end ingest against a fake Hugging Face (no network) and the
 * throwaway database. The fake records every URL so tests can assert what
 * the importer did NOT fetch.
 */

let db: Db;
let close: () => Promise<void>;
let blobDir: string;

beforeAll(async () => {
  ({ db, close } = createDb(inject('testDatabaseUrl')));
  blobDir = await mkdtemp(path.join(tmpdir(), 'cue-ingest-'));
});
afterAll(async () => {
  await close();
  await rm(blobDir, { recursive: true, force: true });
});

const silent = { info: () => undefined, warn: () => undefined };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fakeHub(routes: Record<string, () => Response>) {
  const requested: string[] = [];
  const fetch: FetchFn = (url) => {
    requested.push(decodeURIComponent(url));
    const decoded = decodeURIComponent(url);
    for (const [needle, respond] of Object.entries(routes)) {
      if (decoded.includes(needle)) return Promise.resolve(respond());
    }
    return Promise.resolve(new Response(`unexpected request: ${decoded}`, { status: 404 }));
  };
  return { hf: new HfClient({ fetch, sleep: () => Promise.resolve() }), requested };
}

function run(
  adapters: DatasetAdapter[],
  hf: HfClient,
  extra: { withAudio?: boolean; limit?: number } = {},
) {
  return runIngest({
    adapters,
    hf,
    db,
    blobs: new LocalFsBlobStore(blobDir),
    limit: extra.limit ?? null,
    maxScan: 1000,
    withAudio: extra.withAudio ?? false,
    dryRun: false,
    log: silent,
  });
}

/** A tiny valid stereo 48 kHz WAV (0.5 s of silence). */
function tinyWav(): Buffer {
  const dataBytes = 48000 * 2 * 2 * 0.5;
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(48000, 24);
  b.writeUInt32LE(48000 * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

const REAL_SALES_TRANSCRIPT = [
  'Conversation 1 Transcript',
  '====',
  '',
  '[0:01 - 0:05] Seller:',
  'Hello, Alex.',
  '',
  '[0:06 - 0:09] Partner:',
  'Hey, can you hear me?',
].join('\n');

function realSalesHub() {
  return fakeHub({
    'datasets-server': () => {
      throw new Error('real-sales must not use the rows API (it carries demographics)');
    },
    'metadata.csv': () => {
      throw new Error('real-sales must never fetch metadata.csv (it carries demographics)');
    },
    '/tree/rev1/transcripts': () =>
      json([{ type: 'file', path: 'transcripts/Conversation 1.txt', size: 100 }]),
    '/tree/rev1/data': () =>
      json([
        { type: 'file', path: 'data/Conversation 1.wav', size: 96044 },
        { type: 'file', path: 'data/metadata.csv', size: 5000 },
      ]),
    'resolve/rev1/transcripts/Conversation 1.txt': () => new Response(REAL_SALES_TRANSCRIPT),
    'resolve/rev1/data/Conversation 1.wav': () => new Response(tinyWav()),
    '/api/datasets/liva-ai/real-sales': () => json({ sha: 'rev1', gated: false, cardData: {} }),
  });
}

describe('real-sales ingest', () => {
  it('imports timed transcripts, stores no demographics, and never fetches them', async () => {
    const { hf, requested } = realSalesHub();
    const [summary] = await run([realSalesAdapter], hf);

    expect(summary).toMatchObject({ status: 'imported', license: 'unspecified', imported: 1 });
    expect(requested.some((u) => u.includes('metadata.csv'))).toBe(false);
    expect(requested.some((u) => u.includes('datasets-server'))).toBe(false);

    const [rec] = await db
      .select()
      .from(schema.recordings)
      .where(eq(schema.recordings.datasetId, 'liva-ai/real-sales'));
    expect(rec).toMatchObject({
      timing: 'real',
      hasAudio: true,
      metadata: { conversation_number: 1 },
    });
    const keys = Object.keys(rec?.metadata ?? {});
    for (const k of keys) expect(k).not.toMatch(/age|gender|ethnic|grew/i);
    expect((await getRecordingUtterances(db, rec?.id ?? '')).map((u) => u.speaker)).toEqual([
      'rep',
      'prospect',
    ]);
  });

  it('downloads audio only with --with-audio, into the blob store', async () => {
    const { hf, requested } = realSalesHub();
    await run([realSalesAdapter], hf);
    expect(requested.some((u) => u.endsWith('.wav'))).toBe(false);

    const [summary] = await run([realSalesAdapter], hf, { withAudio: true });
    expect(summary?.audioStored).toBe(1);
    const [audio] = await db.select().from(schema.recordingAudio);
    expect(audio).toMatchObject({
      storageKey: 'liva-ai/real-sales/conversation-1.wav',
      contentType: 'audio/wav',
      sampleRate: 48000,
      channels: 2,
      durationMs: 500,
      bytes: tinyWav().length,
    });
    expect(await new LocalFsBlobStore(blobDir).head(audio?.storageKey ?? '')).toEqual({
      bytes: tinyWav().length,
    });
  });

  it('is idempotent: re-importing leaves one recording with the same utterances', async () => {
    const { hf } = realSalesHub();
    await run([realSalesAdapter], hf);
    await run([realSalesAdapter], hf);
    const { items } = await listRecordings(db, {
      datasetId: 'liva-ai/real-sales',
      limit: 10,
      offset: 0,
    });
    expect(items).toHaveLength(1);
    expect(await getRecordingUtterances(db, items[0]?.id ?? '')).toHaveLength(2);
  });
});

describe('access problems', () => {
  it('skips a gated dataset with an actionable message and writes nothing', async () => {
    const { hf } = fakeHub({
      '/api/datasets/': () => json({ error: 'Invalid username or password.' }, 401),
    });
    const gated: DatasetAdapter = { ...saasAdapter, datasetId: 'org/gated-thing' };
    const [summary] = await run([gated], hf);
    expect(summary).toMatchObject({ status: 'skipped', imported: 0 });
    expect(summary?.message).toMatch(/HF_TOKEN/);
    expect(
      await db.select().from(schema.datasets).where(eq(schema.datasets.id, 'org/gated-thing')),
    ).toEqual([]);
  });
});

describe('saas ingest', () => {
  const conv = JSON.stringify([
    { speaker: 'customer', message: 'hi' },
    { speaker: 'sales_rep', message: 'hello there' },
  ]);
  const row = (i: number, channel: string) => ({
    row: {
      conversation_id: `saas-conv-${String(i)}`,
      company_name: 'Acme',
      product_name: 'Widget',
      product_type: 'Tools',
      communication_channel: channel,
      conversation_style: 'casual',
      conversation_flow: 'single',
      outcome: i % 2,
      conversation: conv,
      scenario: '{"customer_persona":{"name":"Private Person"}}',
    },
  });

  it('falls back to scanning rows when /filter fails, keeps phone calls only, honors --limit', async () => {
    const { hf, requested } = fakeHub({
      'datasets-server.huggingface.co/filter': () => json({ error: 'temporary' }, 500),
      'datasets-server.huggingface.co/rows': () =>
        json({
          rows: [
            row(1, 'sms'),
            row(2, 'phone_call'),
            row(3, 'email'),
            row(4, 'phone_call'),
            row(5, 'phone_call'),
          ],
          num_rows_total: 5,
        }),
      '/api/datasets/DeepMostInnovations/saas-sales-conversations': () =>
        json({ sha: 'r', gated: false, cardData: { license: 'apache-2.0' } }),
    });

    const [summary] = await run([saasAdapter], hf, { limit: 2 });

    expect(summary).toMatchObject({ status: 'imported', license: 'apache-2.0', imported: 2 });
    expect(requested.some((u) => u.includes('/filter'))).toBe(true);
    const { items } = await listRecordings(db, {
      datasetId: 'DeepMostInnovations/saas-sales-conversations',
      limit: 10,
      offset: 0,
    });
    expect(items.map((i) => i.title)).toEqual(['Widget · Acme', 'Widget · Acme']);
    const stored = await db
      .select({ metadata: schema.recordings.metadata })
      .from(schema.recordings)
      .where(eq(schema.recordings.datasetId, 'DeepMostInnovations/saas-sales-conversations'));
    for (const r of stored) {
      expect(r.metadata.communication_channel).toBe('phone_call');
      expect(JSON.stringify(r.metadata)).not.toContain('Private Person');
    }
  });
});
