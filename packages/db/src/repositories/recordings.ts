import { type RecordingMetadata, RecordingMetadataSchema, type Speaker } from '@cue/shared';
import { and, asc, count, desc, eq, gte, lt, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../client';
import {
  type Dataset,
  datasets,
  type Recording,
  recordingAudio,
  recordings,
  recordingUtterances,
} from '../schema';

/**
 * The imported-recording library. Shared by all signed-in users (read-only in
 * the app); written only by the ingest CLI.
 */

// ------------------------------------------------------------------ reads

export interface RecordingFilters {
  datasetId?: string | undefined;
  /** Inclusive lower bound. */
  minDurationMs?: number | undefined;
  /** Exclusive upper bound. */
  maxDurationMs?: number | undefined;
  hasAudio?: boolean | undefined;
  limit: number;
  offset: number;
}

export interface RecordingListItem {
  id: string;
  title: string;
  datasetId: string;
  datasetName: string;
  durationMs: number;
  timing: 'real' | 'estimated';
  hasAudio: boolean;
}

export async function listRecordings(
  db: Db,
  filters: RecordingFilters,
): Promise<{ items: RecordingListItem[]; total: number }> {
  const where: SQL[] = [];
  if (filters.datasetId) where.push(eq(recordings.datasetId, filters.datasetId));
  if (filters.minDurationMs !== undefined) {
    where.push(gte(recordings.durationMs, filters.minDurationMs));
  }
  if (filters.maxDurationMs !== undefined) {
    where.push(lt(recordings.durationMs, filters.maxDurationMs));
  }
  if (filters.hasAudio !== undefined) where.push(eq(recordings.hasAudio, filters.hasAudio));
  const condition = where.length > 0 ? and(...where) : undefined;

  const [items, [totalRow]] = await Promise.all([
    db
      .select({
        id: recordings.id,
        title: recordings.title,
        datasetId: recordings.datasetId,
        datasetName: datasets.name,
        durationMs: recordings.durationMs,
        timing: recordings.timing,
        hasAudio: recordings.hasAudio,
      })
      .from(recordings)
      .innerJoin(datasets, eq(datasets.id, recordings.datasetId))
      .where(condition)
      .orderBy(desc(recordings.hasAudio), asc(recordings.datasetId), asc(recordings.title))
      .limit(filters.limit)
      .offset(filters.offset),
    db.select({ n: count() }).from(recordings).where(condition),
  ]);
  return { items, total: totalRow?.n ?? 0 };
}

export async function listDatasets(db: Db): Promise<Dataset[]> {
  return db.select().from(datasets).orderBy(asc(datasets.name));
}

export interface RecordingDetail extends Recording {
  dataset: Dataset;
}

export async function getRecording(db: Db, recordingId: string): Promise<RecordingDetail | null> {
  if (!z.uuid().safeParse(recordingId).success) return null;
  const [row] = await db
    .select({ recording: recordings, dataset: datasets })
    .from(recordings)
    .innerJoin(datasets, eq(datasets.id, recordings.datasetId))
    .where(eq(recordings.id, recordingId));
  return row ? { ...row.recording, dataset: row.dataset } : null;
}

export async function getRecordingUtterances(db: Db, recordingId: string) {
  if (!z.uuid().safeParse(recordingId).success) return [];
  return db
    .select({
      idx: recordingUtterances.idx,
      speaker: recordingUtterances.speaker,
      text: recordingUtterances.text,
      startedMs: recordingUtterances.startedMs,
      endedMs: recordingUtterances.endedMs,
    })
    .from(recordingUtterances)
    .where(eq(recordingUtterances.recordingId, recordingId))
    .orderBy(asc(recordingUtterances.idx));
}

export interface RecordingAudioInfo {
  storageKey: string;
  contentType: string;
  bytes: number;
  durationMs: number | null;
}

/**
 * Where a recording's original audio is stored, or null if it was never
 * downloaded (`has_audio` can be true without it: ingest without --with-audio).
 * Shared library, like getRecording: the caller must have checked sign-in.
 */
export async function getRecordingAudio(
  db: Db,
  recordingId: string,
): Promise<RecordingAudioInfo | null> {
  if (!z.uuid().safeParse(recordingId).success) return null;
  const [row] = await db
    .select({
      storageKey: recordingAudio.storageKey,
      contentType: recordingAudio.contentType,
      bytes: recordingAudio.bytes,
      durationMs: recordingAudio.durationMs,
    })
    .from(recordingAudio)
    .where(eq(recordingAudio.recordingId, recordingId));
  return row ?? null;
}

// ------------------------------------------------------------------ ingest writes

export interface DatasetInput {
  id: string;
  name: string;
  url: string;
  license: string;
  revision: string | null;
}

export async function upsertDataset(db: Db, input: DatasetInput): Promise<void> {
  await db
    .insert(datasets)
    .values(input)
    .onConflictDoUpdate({
      target: datasets.id,
      set: {
        name: input.name,
        url: input.url,
        license: input.license,
        revision: input.revision,
        importedAt: new Date(),
      },
    });
}

export interface RecordingInput {
  datasetId: string;
  externalId: string;
  title: string;
  timing: 'real' | 'estimated';
  hasAudio: boolean;
  language: string;
  metadata: RecordingMetadata;
  utterances: { speaker: Speaker; text: string; startedMs: number; endedMs: number }[];
}

/**
 * Insert or update a recording by (dataset, external id) and replace its
 * reference transcript, all in one transaction. Idempotent: importing the same
 * data twice leaves the same rows. Sessions that replayed it are untouched
 * (they keep their own utterances in `utterances`).
 */
export async function upsertRecording(db: Db, input: RecordingInput): Promise<string> {
  // Second line of defense: never store demographic metadata, whatever the adapter did.
  const metadata = RecordingMetadataSchema.parse(input.metadata);
  const durationMs = input.utterances.reduce((max, u) => Math.max(max, u.endedMs), 0);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(recordings)
      .values({
        datasetId: input.datasetId,
        externalId: input.externalId,
        title: input.title,
        durationMs,
        timing: input.timing,
        hasAudio: input.hasAudio,
        language: input.language,
        metadata,
      })
      .onConflictDoUpdate({
        target: [recordings.datasetId, recordings.externalId],
        set: {
          title: input.title,
          durationMs,
          timing: input.timing,
          hasAudio: input.hasAudio,
          language: input.language,
          metadata,
        },
      })
      .returning({ id: recordings.id });
    if (!row) throw new Error('recording upsert returned nothing');

    await tx.delete(recordingUtterances).where(eq(recordingUtterances.recordingId, row.id));
    if (input.utterances.length > 0) {
      await tx
        .insert(recordingUtterances)
        .values(input.utterances.map((u, idx) => ({ ...u, idx, recordingId: row.id })));
    }
    return row.id;
  });
}

export interface RecordingAudioInput {
  recordingId: string;
  storageKey: string;
  contentType: string;
  bytes: number;
  sampleRate: number | null;
  channels: number | null;
  durationMs: number | null;
  sha256: string;
}

export async function upsertRecordingAudio(db: Db, input: RecordingAudioInput): Promise<void> {
  const { recordingId, ...rest } = input;
  await db.transaction(async (tx) => {
    await tx
      .insert(recordingAudio)
      .values(input)
      .onConflictDoUpdate({ target: recordingAudio.recordingId, set: rest });
    await tx.update(recordings).set({ hasAudio: true }).where(eq(recordings.id, recordingId));
  });
}
