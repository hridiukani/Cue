import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  getRecording,
  getRecordingUtterances,
  listRecordings,
  upsertDataset,
  upsertRecording,
  upsertRecordingAudio,
} from '../src/repositories/recordings';
import { createReplaySession, getSession } from '../src/repositories/sessions';
import { recordings, recordingUtterances } from '../src/schema';
import { connectTestDb, makeRecording, makeUser } from './helpers';

const { db, close } = connectTestDb();
afterAll(close);

describe('upsertRecording', () => {
  it('is idempotent and replaces the reference transcript', async () => {
    const datasetId = `test/${randomUUID()}`;
    await upsertDataset(db, {
      id: datasetId,
      name: 'D',
      url: 'u',
      license: 'mit',
      revision: 'abc',
    });
    const base = {
      datasetId,
      externalId: 'call-1',
      title: 'Call 1',
      timing: 'estimated' as const,
      hasAudio: false,
      language: 'en',
      metadata: { product_type: 'SaaS' },
      utterances: [
        { speaker: 'rep' as const, text: 'Hi', startedMs: 0, endedMs: 500 },
        { speaker: 'prospect' as const, text: 'Hello', startedMs: 900, endedMs: 1500 },
      ],
    };
    const first = await upsertRecording(db, base);
    const second = await upsertRecording(db, {
      ...base,
      title: 'Call 1 (re-imported)',
      utterances: [{ speaker: 'rep', text: 'Only line', startedMs: 0, endedMs: 4000 }],
    });

    expect(second).toBe(first);
    expect(
      await db.select().from(recordings).where(eq(recordings.datasetId, datasetId)),
    ).toHaveLength(1);
    expect(await getRecordingUtterances(db, first)).toEqual([
      { idx: 0, speaker: 'rep', text: 'Only line', startedMs: 0, endedMs: 4000 },
    ]);
    expect(await getRecording(db, first)).toMatchObject({
      title: 'Call 1 (re-imported)',
      durationMs: 4000,
    });
  });

  it('refuses demographic metadata even if an adapter passes it through', async () => {
    const { datasetId } = await makeRecording(db, 1);
    await expect(
      upsertRecording(db, {
        datasetId,
        externalId: 'leaky',
        title: 'x',
        timing: 'real',
        hasAudio: false,
        language: 'en',
        metadata: { seller_age_range: '25-34' },
        utterances: [],
      }),
    ).rejects.toThrow(/Demographic/);
    expect(await db.select().from(recordings).where(eq(recordings.externalId, 'leaky'))).toEqual(
      [],
    );
  });

  it('records audio and flips has_audio', async () => {
    const { recordingId } = await makeRecording(db, 1);
    await upsertRecordingAudio(db, {
      recordingId,
      storageKey: `audio/${recordingId}.wav`,
      contentType: 'audio/wav',
      bytes: 1234,
      sampleRate: 48000,
      channels: 2,
      durationMs: 1000,
      sha256: 'f'.repeat(64),
    });
    expect((await getRecording(db, recordingId))?.hasAudio).toBe(true);
  });
});

describe('listRecordings', () => {
  it('filters by dataset, duration and audio, and reports the total', async () => {
    const { datasetId, recordingId: short } = await makeRecording(db, 2); // ends at 1800 ms
    const { recordingId: long } = await makeRecording(db, 20, datasetId); // ends at 19800 ms
    await db.update(recordings).set({ hasAudio: true }).where(eq(recordings.id, long));

    const all = await listRecordings(db, { datasetId, limit: 10, offset: 0 });
    expect(all.total).toBe(2);

    const shortOnly = await listRecordings(db, {
      datasetId,
      maxDurationMs: 5000,
      limit: 10,
      offset: 0,
    });
    expect(shortOnly.items.map((r) => r.id)).toEqual([short]);

    const withAudio = await listRecordings(db, { datasetId, hasAudio: true, limit: 10, offset: 0 });
    expect(withAudio.items.map((r) => r.id)).toEqual([long]);

    const page = await listRecordings(db, { datasetId, limit: 1, offset: 1 });
    expect(page).toMatchObject({ total: 2 });
    expect(page.items).toHaveLength(1);
  });
});

describe('deleting a recording', () => {
  it('keeps the replay sessions that played it (recording_id set to null)', async () => {
    const user = await makeUser(db);
    const { recordingId } = await makeRecording(db, 2);
    const session = await createReplaySession(db, user.id, recordingId);
    if (!session) throw new Error('no session');

    await db.delete(recordings).where(eq(recordings.id, recordingId));

    expect(await getSession(db, user.id, session.id)).toMatchObject({ recordingId: null });
    expect(
      await db
        .select()
        .from(recordingUtterances)
        .where(eq(recordingUtterances.recordingId, recordingId)),
    ).toEqual([]);
  });
});
