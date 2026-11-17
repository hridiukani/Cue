import { type Db, upsertDataset, upsertRecording, upsertRecordingAudio } from '@cue/db';
import type { BlobStore } from '@cue/storage';
import { parseWavHeader } from './core';
import type { HfClient } from './hf-client';
import type { DatasetAdapter, Logger } from './types';

export interface IngestOptions {
  adapters: DatasetAdapter[];
  hf: HfClient;
  db: Db;
  /** Required when withAudio is true. */
  blobs: BlobStore | null;
  /** Overrides each adapter's default limit. */
  limit: number | null;
  maxScan: number;
  withAudio: boolean;
  dryRun: boolean;
  log: Logger;
}

export interface DatasetSummary {
  dataset: string;
  status: 'imported' | 'skipped';
  /** Why the whole dataset was skipped (access, not found), if it was. */
  message?: string;
  license?: string;
  imported: number;
  skipped: { externalId: string; reason: string }[];
  failed: { externalId: string; error: string }[];
  audioStored: number;
}

/** Import every adapter's recordings. One bad recording never stops the rest. */
export async function runIngest(opts: IngestOptions): Promise<DatasetSummary[]> {
  if (opts.withAudio && !opts.blobs) throw new Error('withAudio requires a BlobStore');
  const summaries: DatasetSummary[] = [];

  for (const adapter of opts.adapters) {
    const summary: DatasetSummary = {
      dataset: adapter.datasetId,
      status: 'imported',
      imported: 0,
      skipped: [],
      failed: [],
      audioStored: 0,
    };
    summaries.push(summary);
    opts.log.info(`${adapter.datasetId}: checking access…`);

    const probe = await opts.hf.probe(adapter.datasetId);
    if (!probe.ok) {
      summary.status = 'skipped';
      summary.message = probe.message;
      opts.log.warn(`${adapter.datasetId}: skipped. ${probe.message}`);
      continue;
    }
    summary.license = probe.license;
    if (probe.license === 'unspecified') {
      opts.log.warn(
        `${adapter.datasetId}: the dataset card states no license. Keep it private (see docs/datasets.md).`,
      );
    }
    if (!opts.dryRun) {
      await upsertDataset(opts.db, {
        id: adapter.datasetId,
        name: adapter.name,
        url: `https://huggingface.co/datasets/${adapter.datasetId}`,
        license: probe.license,
        revision: probe.revision,
      });
    }

    const items = adapter.recordings({
      hf: opts.hf,
      revision: probe.revision,
      limit: opts.limit ?? adapter.defaultLimit,
      maxScan: opts.maxScan,
      log: opts.log,
    });
    for await (const item of items) {
      if (item.kind === 'skip') {
        summary.skipped.push({ externalId: item.externalId, reason: item.reason });
        continue;
      }
      const { recording } = item;
      try {
        if (opts.dryRun) {
          summary.imported++;
          continue;
        }
        const recordingId = await upsertRecording(opts.db, {
          ...recording,
          datasetId: adapter.datasetId,
        });
        summary.imported++;
        if (opts.withAudio && opts.blobs && item.audioPath) {
          await storeAudio(
            opts,
            adapter,
            probe.revision,
            recordingId,
            recording.externalId,
            item.audioPath,
          );
          summary.audioStored++;
        }
      } catch (err) {
        summary.failed.push({
          externalId: recording.externalId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    opts.log.info(
      `${adapter.datasetId}: ${String(summary.imported)} imported, ${String(summary.skipped.length)} skipped, ` +
        `${String(summary.failed.length)} failed${opts.withAudio ? `, ${String(summary.audioStored)} audio files stored` : ''}.`,
    );
  }
  return summaries;
}

/** Safe blob key from a dataset id and external id, e.g. "liva-ai/real-sales/conversation-1.wav". */
export function audioKey(datasetId: string, externalId: string, filePath: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+|-+$/g, '');
  const ext = /\.[a-z0-9]+$/.exec(filePath.toLowerCase())?.[0] ?? '';
  return [...datasetId.split('/').map(slug), `${slug(externalId)}${ext}`].join('/');
}

async function storeAudio(
  opts: IngestOptions,
  adapter: DatasetAdapter,
  revision: string,
  recordingId: string,
  externalId: string,
  audioPath: string,
): Promise<void> {
  const blobs = opts.blobs;
  if (!blobs) return;
  const key = audioKey(adapter.datasetId, externalId, audioPath);
  opts.log.info(`${adapter.datasetId}: downloading ${audioPath}…`);
  const { bytes, sha256 } = await blobs.put(
    key,
    await opts.hf.fileStream(adapter.datasetId, revision, audioPath),
  );

  // Read just the header back to record format and duration.
  const stream = await blobs.get(key);
  const head: Buffer[] = [];
  let have = 0;
  for await (const chunk of stream) {
    const b = chunk as Buffer;
    head.push(b);
    have += b.length;
    if (have >= 64 * 1024) break;
  }
  stream.destroy();
  const wav = parseWavHeader(Buffer.concat(head));

  await upsertRecordingAudio(opts.db, {
    recordingId,
    storageKey: key,
    contentType: wav ? 'audio/wav' : 'application/octet-stream',
    bytes,
    sampleRate: wav?.sampleRate ?? null,
    channels: wav?.channels ?? null,
    durationMs: wav?.durationMs ?? null,
    sha256,
  });
}
