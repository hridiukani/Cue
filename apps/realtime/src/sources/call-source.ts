import type { Speaker, Speed } from '@cue/shared';

/**
 * A source of call events on a timeline. Today the only implementation is
 * TranscriptSource (replays a timed reference transcript). Speech-to-text over
 * recorded audio ('stt') and a live microphone/phone source ('live') will
 * implement the same interface, so nothing above it changes.
 */

export type SourceEvent =
  | { type: 'interim'; speaker: Speaker; key: string; text: string; startMs: number; endMs: number }
  | {
      type: 'final';
      speaker: Speaker;
      key: string;
      text: string;
      startMs: number;
      endMs: number;
      confidence: number | null;
    }
  | { type: 'position'; positionMs: number }
  | { type: 'ended' }
  | {
      type: 'error';
      code: 'source_unavailable' | 'source_corrupt';
      message: string;
      retryable: boolean;
    };

export interface CallSourceCapabilities {
  seek: boolean;
  speeds: readonly Speed[];
}

export interface CallSource {
  readonly kind: 'transcript' | 'stt' | 'live';
  /** Total timeline length; null for live sources. */
  readonly durationMs: number | null;
  readonly capabilities: CallSourceCapabilities;
  /** Current timeline position (ms). */
  readonly positionMs: number;
  readonly speed: Speed;
  readonly playing: boolean;

  /** Begin emitting events at or after `fromMs`. */
  start(fromMs: number, speed: Speed): void;
  pause(): void;
  resume(): void;
  /** Jump to `toMs`. Anything scheduled before the seek is dropped. */
  seek(toMs: number): void;
  setSpeed(speed: Speed): void;
  close(): Promise<void>;
  /** Subscribe; returns an unsubscribe function. */
  on(listener: (e: SourceEvent) => void): () => void;
}
