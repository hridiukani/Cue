import path from 'node:path';
import { estimateTimeline, mapSpeaker, pickMetadata, type Turn } from '../core';
import type { AdapterItem, DatasetAdapter } from '../types';

/**
 * gwenshap/sales-transcripts: 51 short simulated calls as markdown,
 * "**Sales Rep**: …" / "**Customer**: …". No timestamps, so timing is estimated.
 */

const LINE = /^\*\*(.+?)\*\*:\s*(.*)$/;

export type ParsedTranscript = { ok: true; turns: Turn[] } | { ok: false; reason: string };

export function parseGwenshapTranscript(text: string): ParsedTranscript {
  const turns: Turn[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = LINE.exec(line);
    if (m) {
      const label = m[1] ?? '';
      const speaker = mapSpeaker(label);
      if (!speaker) return { ok: false, reason: `unknown speaker label "${label}"` };
      turns.push({ speaker, text: m[2] ?? '' });
    } else if (turns.length > 0) {
      // A continuation line belongs to the previous speaker.
      const last = turns[turns.length - 1];
      if (last) last.text = `${last.text} ${line}`.trim();
    }
  }
  const nonEmpty = turns.filter((t) => t.text.trim().length > 0);
  if (nonEmpty.length < 2) return { ok: false, reason: 'fewer than 2 turns' };
  return { ok: true, turns: nonEmpty };
}

/** "nexiv-solutions__3_transcript.txt" → { externalId: "nexiv-solutions__3", company: "Nexiv Solutions", index: 3 } */
export function describeFile(file: string): { externalId: string; company: string; index: number } {
  const base = path.posix
    .basename(file)
    .replace(/_transcript\.txt$/i, '')
    .replace(/\.txt$/i, '');
  const [slug = base, n = '0'] = base.split('__');
  const company = slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return { externalId: base, company, index: Number.parseInt(n, 10) || 0 };
}

export const gwenshapAdapter: DatasetAdapter = {
  key: 'gwenshap',
  datasetId: 'gwenshap/sales-transcripts',
  name: 'Simulated sales transcripts (gwenshap)',
  defaultLimit: null,
  async *recordings(ctx): AsyncIterable<AdapterItem> {
    const files = (await ctx.hf.listTree(this.datasetId, ctx.revision, 'data/transcripts'))
      .filter((f) => f.type === 'file' && f.path.endsWith('.txt'))
      .map((f) => f.path)
      .sort();

    let yielded = 0;
    for (const file of files) {
      if (ctx.limit !== null && yielded >= ctx.limit) return;
      const { externalId, company, index } = describeFile(file);
      const parsed = parseGwenshapTranscript(
        await ctx.hf.fileText(this.datasetId, ctx.revision, file),
      );
      if (!parsed.ok) {
        yield { kind: 'skip', externalId, reason: parsed.reason };
        continue;
      }
      yielded++;
      yield {
        kind: 'recording',
        recording: {
          externalId,
          title: `${company} · conversation ${String(index + 1)}`,
          timing: 'estimated',
          hasAudio: false,
          language: 'en',
          metadata: pickMetadata({ company }, ['company']),
          utterances: estimateTimeline(parsed.turns),
        },
      };
    }
  },
};
