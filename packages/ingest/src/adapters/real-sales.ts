import path from 'node:path';
import { mapSpeaker, normalizeTimeline, pickMetadata, type TimedTurn } from '../core';
import type { AdapterItem, DatasetAdapter } from '../types';

/**
 * liva-ai/real-sales: 7 unscripted calls with real timestamps
 * ("[0:01 - 0:50] Seller:" blocks) and one stereo WAV per call.
 *
 * PRIVACY: the dataset also publishes each speaker's age range, gender,
 * ethnicity and where they grew up (data/metadata.csv and the rows API). This
 * adapter never requests those sources: it reads only transcripts/*.txt and
 * the file listing. Tests assert metadata.csv is never fetched.
 *
 * LICENSE: the dataset card states none; see docs/datasets.md.
 */

const BLOCK = /^\[(\d{1,2}(?::\d{2}){1,2})\s*-\s*(\d{1,2}(?::\d{2}){1,2})\]\s*([^:\n]+):[ \t]*$/;

/** "1:05" → 65000, "1:02:03" → 3723000. */
export function parseTimestamp(ts: string): number {
  return (
    ts
      .split(':')
      .map((p) => Number.parseInt(p, 10))
      .reduce((acc, n) => acc * 60 + n, 0) * 1000
  );
}

export type ParsedTimed =
  | { ok: true; turns: TimedTurn[]; reordered: number; repaired: number }
  | { ok: false; reason: string };

export function parseRealSalesTranscript(text: string): ParsedTimed {
  const turns: TimedTurn[] = [];
  let current: TimedTurn | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = BLOCK.exec(raw.trim());
    if (m) {
      const label = (m[3] ?? '').trim();
      const speaker = mapSpeaker(label);
      if (!speaker) return { ok: false, reason: `unknown speaker label "${label}"` };
      const startedMs = parseTimestamp(m[1] ?? '0');
      // Timestamps have 1-second resolution and "[0:55 - 0:55]" is common,
      // so treat the end second as inclusive.
      const endedMs = Math.max(startedMs, parseTimestamp(m[2] ?? '0') + 999);
      current = { speaker, text: '', startedMs, endedMs };
      turns.push(current);
    } else if (current && raw.trim()) {
      current.text = `${current.text} ${raw.trim()}`.trim();
    }
  }
  if (turns.length < 2) return { ok: false, reason: 'no timestamped turns found' };
  const { turns: cleaned, reordered, repaired } = normalizeTimeline(turns);
  return { ok: true, turns: cleaned, reordered, repaired };
}

export const realSalesAdapter: DatasetAdapter = {
  key: 'real-sales',
  datasetId: 'liva-ai/real-sales',
  name: 'Real sales conversations (liva-ai)',
  defaultLimit: null,
  async *recordings(ctx): AsyncIterable<AdapterItem> {
    const [transcripts, data] = await Promise.all([
      ctx.hf.listTree(this.datasetId, ctx.revision, 'transcripts'),
      ctx.hf.listTree(this.datasetId, ctx.revision, 'data'),
    ]);
    const wavs = new Set(data.filter((f) => f.path.endsWith('.wav')).map((f) => f.path));
    const files = transcripts
      .filter((f) => f.type === 'file' && f.path.endsWith('.txt'))
      .map((f) => f.path)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

    let yielded = 0;
    for (const file of files) {
      if (ctx.limit !== null && yielded >= ctx.limit) return;
      const name = path.posix.basename(file, '.txt'); // "Conversation 1"
      const number = Number.parseInt(/(\d+)$/.exec(name)?.[1] ?? '', 10);
      const parsed = parseRealSalesTranscript(
        await ctx.hf.fileText(this.datasetId, ctx.revision, file),
      );
      if (!parsed.ok) {
        yield { kind: 'skip', externalId: name, reason: parsed.reason };
        continue;
      }
      if (parsed.reordered + parsed.repaired > 0) {
        ctx.log.warn(
          `${name}: fixed ${String(parsed.reordered)} out-of-order and ${String(parsed.repaired)} invalid timestamps`,
        );
      }
      const audioPath = `data/${name}.wav`;
      const hasAudio = wavs.has(audioPath);
      yielded++;
      yield {
        kind: 'recording',
        recording: {
          externalId: name,
          title: `Real sales · conversation ${Number.isNaN(number) ? name : String(number)}`,
          timing: 'real',
          hasAudio,
          language: 'en',
          metadata: pickMetadata({ conversation_number: Number.isNaN(number) ? null : number }, [
            'conversation_number',
          ]),
          utterances: parsed.turns,
        },
        ...(hasAudio ? { audioPath } : {}),
      };
    }
  },
};
