import type { RecordingMetadata } from '@cue/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz } from './columns';
import { speakerEnum, timingEnum } from './enums';

/**
 * Imported recordings: a read-only library shared by all signed-in users and
 * owned by nobody. Replays of a recording are sessions in `calls` (owned by a
 * user); nothing here changes when someone replays.
 */

/** A source dataset, e.g. "gwenshap/sales-transcripts". */
export const datasets = pgTable('datasets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  // SPDX-ish id from the dataset card, or 'unspecified' when none is stated.
  license: text('license').notNull(),
  // Hugging Face commit sha the import was taken from, for reproducibility.
  revision: text('revision'),
  importedAt: timestamptz('imported_at').notNull().defaultNow(),
});

export const recordings = pgTable(
  'recordings',
  {
    id: id(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    durationMs: integer('duration_ms').notNull(),
    timing: timingEnum('timing').notNull(),
    hasAudio: boolean('has_audio').notNull().default(false),
    language: text('language').notNull().default('en'),
    // Allowlisted, flat facts only (validated by RecordingMetadataSchema). No demographics.
    metadata: jsonb('metadata')
      .$type<RecordingMetadata>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    unique('recordings_dataset_external_key').on(t.datasetId, t.externalId),
    index('recordings_dataset_id_idx').on(t.datasetId),
    index('recordings_duration_ms_idx').on(t.durationMs),
    index('recordings_has_audio_idx').on(t.hasAudio),
    check('recordings_duration_nonnegative', sql`${t.durationMs} >= 0`),
  ],
);

/** The reference transcript of a recording, in order. */
export const recordingUtterances = pgTable(
  'recording_utterances',
  {
    id: id(),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    speaker: speakerEnum('speaker').notNull(),
    text: text('text').notNull(),
    startedMs: integer('started_ms').notNull(),
    endedMs: integer('ended_ms').notNull(),
  },
  (t) => [
    // Also serves "utterances of recording X in order" lookups.
    unique('recording_utterances_recording_idx_key').on(t.recordingId, t.idx),
    check('recording_utterances_started_nonnegative', sql`${t.startedMs} >= 0`),
    check('recording_utterances_ended_after_started', sql`${t.endedMs} >= ${t.startedMs}`),
  ],
);

/**
 * The original audio file of a recording, stored unprocessed in a BlobStore
 * (only when imported with --with-audio). Used by later speech-to-text and
 * browser-playback steps.
 */
export const recordingAudio = pgTable('recording_audio', {
  recordingId: uuid('recording_id')
    .primaryKey()
    .references(() => recordings.id, { onDelete: 'cascade' }),
  storageKey: text('storage_key').notNull(),
  contentType: text('content_type').notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  sampleRate: integer('sample_rate'),
  channels: integer('channels'),
  durationMs: integer('duration_ms'),
  sha256: text('sha256').notNull(),
  createdAt: createdAt(),
});

export type Dataset = typeof datasets.$inferSelect;
export type Recording = typeof recordings.$inferSelect;
export type RecordingUtterance = typeof recordingUtterances.$inferSelect;
export type RecordingAudio = typeof recordingAudio.$inferSelect;
