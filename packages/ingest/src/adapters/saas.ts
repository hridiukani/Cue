import { z } from 'zod';
import { estimateTimeline, mapSpeaker, pickMetadata, type Turn } from '../core';
import type { AdapterItem, DatasetAdapter } from '../types';
import type { ParsedTranscript } from './gwenshap';

/**
 * DeepMostInnovations/saas-sales-conversations: 100k synthetic SaaS dialogues
 * across many channels (sms, email, phone_call, ...). We import phone calls
 * only. The CSV is 7 GB (mostly embeddings), so rows come from the HF
 * datasets-server API page by page instead.
 */

export const PHONE_CHANNEL = 'phone_call';
const PAGE = 100;
const METADATA_ALLOWLIST = [
  'product_type',
  'conversation_style',
  'conversation_flow',
  'communication_channel',
  'outcome',
] as const;

const SaasRowSchema = z
  .object({
    conversation_id: z.string().min(1),
    company_name: z.string(),
    product_name: z.string(),
    communication_channel: z.string(),
    conversation: z.string(),
  })
  .loose();

const TurnsSchema = z.array(z.object({ speaker: z.string(), message: z.string() }).loose());

export function parseSaasConversation(json: string): ParsedTranscript {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'conversation is not valid JSON' };
  }
  const parsed = TurnsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'conversation has an unexpected shape' };
  const turns: Turn[] = [];
  for (const t of parsed.data) {
    const speaker = mapSpeaker(t.speaker);
    if (!speaker) return { ok: false, reason: `unknown speaker label "${t.speaker}"` };
    if (t.message.trim()) turns.push({ speaker, text: t.message.trim() });
  }
  if (turns.length < 2) return { ok: false, reason: 'fewer than 2 turns' };
  return { ok: true, turns };
}

export function saasRowToItem(row: Record<string, unknown>): AdapterItem | null {
  const r = SaasRowSchema.safeParse(row);
  if (!r.success)
    return { kind: 'skip', externalId: '(unknown)', reason: 'row has an unexpected shape' };
  if (r.data.communication_channel !== PHONE_CHANNEL) return null;
  const parsed = parseSaasConversation(r.data.conversation);
  if (!parsed.ok)
    return { kind: 'skip', externalId: r.data.conversation_id, reason: parsed.reason };
  return {
    kind: 'recording',
    recording: {
      externalId: r.data.conversation_id,
      title: `${r.data.product_name} · ${r.data.company_name}`,
      timing: 'estimated',
      hasAudio: false,
      language: 'en',
      metadata: pickMetadata(row, METADATA_ALLOWLIST),
      utterances: estimateTimeline(parsed.turns),
    },
  };
}

export const saasAdapter: DatasetAdapter = {
  key: 'saas',
  datasetId: 'DeepMostInnovations/saas-sales-conversations',
  name: 'Synthetic SaaS sales conversations (DeepMost)',
  defaultLimit: 300,
  async *recordings(ctx): AsyncIterable<AdapterItem> {
    const q = { config: 'default', split: 'train' };
    let yielded = 0;
    const want = () => ctx.limit === null || yielded < ctx.limit;

    // Preferred: let the server filter to phone calls.
    let useFilter = true;
    try {
      await ctx.hf.rows(this.datasetId, {
        ...q,
        offset: 0,
        length: 1,
        where: `"communication_channel"='${PHONE_CHANNEL}'`,
      });
    } catch (err) {
      useFilter = false;
      ctx.log.warn(
        `datasets-server /filter unavailable (${err instanceof Error ? err.message : String(err)}); ` +
          `scanning rows and filtering locally (at most ${String(ctx.maxScan)} rows, ~12 MB per 100).`,
      );
    }

    for (let offset = 0; want(); offset += PAGE) {
      if (!useFilter && offset >= ctx.maxScan) {
        ctx.log.warn(`stopped after scanning ${String(offset)} rows (--max-scan).`);
        return;
      }
      const page = await ctx.hf.rows(this.datasetId, {
        ...q,
        offset,
        length: PAGE,
        ...(useFilter ? { where: `"communication_channel"='${PHONE_CHANNEL}'` } : {}),
      });
      if (page.rows.length === 0) return;
      for (const row of page.rows) {
        if (!want()) return;
        const item = saasRowToItem(row);
        if (!item) continue;
        if (item.kind === 'recording') yielded++;
        yield item;
      }
      if (offset + PAGE >= page.total) return;
    }
  },
};
