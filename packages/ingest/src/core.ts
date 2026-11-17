import { type RecordingMetadata, RecordingMetadataSchema, type Speaker } from '@cue/shared';

// ------------------------------------------------------------------ speakers

const REP_LABELS = new Set(['seller', 'sales rep', 'sales_rep', 'salesrep', 'rep', 'agent']);
const PROSPECT_LABELS = new Set(['partner', 'customer', 'prospect', 'buyer', 'client']);

/** Map a dataset's speaker label to Cue's roles. Unknown labels return null (never guess). */
export function mapSpeaker(label: string): Speaker | null {
  const l = label.trim().toLowerCase().replace(/\s+/g, ' ');
  if (REP_LABELS.has(l)) return 'rep';
  if (PROSPECT_LABELS.has(l)) return 'prospect';
  return null;
}

// ------------------------------------------------------------------ timing

export interface Turn {
  speaker: Speaker;
  text: string;
}

export interface TimedTurn extends Turn {
  startedMs: number;
  endedMs: number;
}

/** Speaking-rate model for datasets with no timestamps. */
export const ESTIMATE = { msPerWord: 375, minUtteranceMs: 800, gapMs: 600 } as const; // 375 ms/word ≈ 160 wpm

/**
 * Give text-only transcripts a plausible timeline: each turn lasts
 * (words × 375 ms), at least 800 ms, with a 600 ms pause between turns.
 * Recordings built this way are stored with timing = 'estimated'.
 */
export function estimateTimeline(turns: Turn[]): TimedTurn[] {
  let cursor = 0;
  return turns.map((t, i) => {
    const words = t.text.split(/\s+/).filter(Boolean).length;
    const duration = Math.max(ESTIMATE.minUtteranceMs, words * ESTIMATE.msPerWord);
    const startedMs = i === 0 ? 0 : cursor + ESTIMATE.gapMs;
    cursor = startedMs + duration;
    return { ...t, startedMs, endedMs: cursor };
  });
}

/**
 * Clean real timestamps: drop empty text, sort by start (stable), and make
 * sure 0 <= start <= end. `reordered` and `repaired` count what was fixed, so
 * the importer can warn about messy source data.
 */
export function normalizeTimeline(turns: TimedTurn[]): {
  turns: TimedTurn[];
  reordered: number;
  repaired: number;
} {
  const sorted = turns
    .map((t, i) => ({ t: { ...t, text: t.text.trim() }, i }))
    .filter(({ t }) => t.text.length > 0)
    .sort((a, b) => a.t.startedMs - b.t.startedMs || a.i - b.i);

  // A row is "reordered" if it came before the previous row in the source.
  let reordered = 0;
  for (let k = 1; k < sorted.length; k++) {
    if ((sorted[k]?.i ?? 0) < (sorted[k - 1]?.i ?? 0)) reordered++;
  }

  let repaired = 0;
  const cleaned = sorted.map(({ t }) => {
    if (t.startedMs >= 0 && t.endedMs >= t.startedMs) return t;
    repaired++;
    const startedMs = Math.max(0, t.startedMs);
    return { ...t, startedMs, endedMs: Math.max(startedMs, t.endedMs) };
  });
  return { turns: cleaned, reordered, repaired };
}

// ------------------------------------------------------------------ metadata

/**
 * Copy only allowlisted fields (string/number/boolean/null) from a source row.
 * Everything else, including demographics, is dropped here and never reaches
 * the database. RecordingMetadataSchema double-checks the result.
 */
export function pickMetadata(
  row: Record<string, unknown>,
  allowlist: readonly string[],
): RecordingMetadata {
  const out: Record<string, string | number | boolean | null> = {};
  for (const key of allowlist) {
    const v = row[key];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[key] = typeof v === 'string' ? v.slice(0, 500) : v;
    }
  }
  return RecordingMetadataSchema.parse(out);
}

// ------------------------------------------------------------------ WAV header

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationMs: number | null;
}

/**
 * Read a PCM WAV header (RIFF/WAVE, "fmt " and "data" chunks) from the first
 * bytes of a file. Returns null if it isn't a WAV we understand.
 */
export function parseWavHeader(buf: Uint8Array): WavInfo | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (
    b.length < 12 ||
    b.toString('ascii', 0, 4) !== 'RIFF' ||
    b.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return null;
  }
  let offset = 12;
  let fmt: Omit<WavInfo, 'durationMs'> | null = null;
  while (offset + 8 <= b.length) {
    const id = b.toString('ascii', offset, offset + 4);
    const size = b.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= b.length) {
      fmt = {
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        bitsPerSample: b.readUInt16LE(body + 14),
      };
    } else if (id === 'data' && fmt) {
      const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
      return {
        ...fmt,
        durationMs: bytesPerSecond > 0 ? Math.round((size / bytesPerSecond) * 1000) : null,
      };
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  return fmt ? { ...fmt, durationMs: null } : null;
}
