import type { RecordingInput } from '@cue/db';
import type { HfClient } from './hf-client';

export type AdapterKey = 'real-sales' | 'gwenshap' | 'saas';

/** A recording ready to upsert, minus the dataset id (the runner adds it). */
export type ImportedRecording = Omit<RecordingInput, 'datasetId'>;

export type AdapterItem =
  | {
      kind: 'recording';
      recording: ImportedRecording;
      /** Path of the original audio file in the dataset repo, if it has one. */
      audioPath?: string;
    }
  | { kind: 'skip'; externalId: string; reason: string };

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface AdapterContext {
  hf: HfClient;
  revision: string;
  /** Max recordings to yield (null = adapter default / no limit). */
  limit: number | null;
  log: Logger;
}

export interface DatasetAdapter {
  key: AdapterKey;
  datasetId: string;
  name: string;
  /** Applied when --limit isn't given. */
  defaultLimit: number | null;
  recordings(ctx: AdapterContext): AsyncIterable<AdapterItem>;
}
