import { type PlaybookForPrompt, renderPlaybook, type WindowUtterance } from '@cue/suggest';
import { z } from 'zod';
import type { EvalCase } from './cases';

/**
 * Turn a case into what the runner needs: the conversation window and the
 * playbook. Inline windows are used as they are; a null window is loaded from
 * the local database (datasets without a license are never copied into the
 * repo), and must still end with the prospect, or the data changed.
 */

const PlaybookSchema = z
  .object({
    name: z.string().min(1),
    status: z.enum(['DRAFT', 'REVIEWED']),
    productDescription: z.string().min(1),
    idealCustomer: z.string().min(1),
    objections: z.array(
      z.object({ objection: z.string().min(1), good_response: z.string().min(1) }),
    ),
    toneNotes: z.string().nullable(),
  })
  .strict();

const PlaybooksFileSchema = z.record(z.string().regex(/^[a-z0-9-]+$/), PlaybookSchema);

export type EvalPlaybooks = Record<string, PlaybookForPrompt>;

export function parsePlaybooks(text: string): EvalPlaybooks {
  const parsed = PlaybooksFileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`Invalid playbooks file:\n${z.prettifyError(parsed.error)}`);
  if ('none' in parsed.data) throw new Error('"none" is reserved for "no playbook"');
  return Object.fromEntries(
    Object.entries(parsed.data).map(([key, { status: _status, ...p }]) => [key, p]),
  );
}

export interface ResolvedCase {
  case: EvalCase;
  window: WindowUtterance[];
  playbook: PlaybookForPrompt | null;
  /** The playbook as the model sees it, for the judge. */
  playbookText: string | null;
}

/** Utterances of one recording by dataset + external id, oldest first, or null if not imported. */
export type LoadUtterances = (
  dataset: string,
  callId: string,
) => Promise<{ idx: number; speaker: 'rep' | 'prospect'; text: string }[] | null>;

export type ResolveResult =
  { ok: true; resolved: ResolvedCase } | { ok: false; caseId: string; reason: string };

export async function resolveCase(
  c: EvalCase,
  playbooks: EvalPlaybooks,
  loadUtterances: LoadUtterances | null,
): Promise<ResolveResult> {
  const skip = (reason: string): ResolveResult => ({ ok: false, caseId: c.id, reason });
  let playbook: PlaybookForPrompt | null = null;
  if (c.playbook !== 'none') {
    const p = playbooks[c.playbook];
    if (!p) return skip(`unknown playbook "${c.playbook}"`);
    playbook = p;
  }

  let window = c.window;
  if (!window) {
    if (!loadUtterances) return skip('window lives in the local database, which is not connected');
    const all = await loadUtterances(c.source.dataset, c.source.callId);
    if (!all)
      return skip(`${c.source.dataset} ${c.source.callId} is not imported here (run pnpm ingest)`);
    const [first, last] = c.source.utterances;
    const slice = all.filter((u) => u.idx >= first && u.idx <= last);
    if (slice.length !== last - first + 1) {
      return skip(`utterances ${String(first)}-${String(last)} not found in ${c.source.callId}`);
    }
    window = slice.map((u) => ({ speaker: u.speaker, text: u.text }));
    if (window.at(-1)?.speaker !== 'prospect') {
      return skip('the loaded window no longer ends with the prospect: the data changed');
    }
  }
  return {
    ok: true,
    resolved: {
      case: c,
      window,
      playbook,
      playbookText: playbook ? renderPlaybook(playbook) : null,
    },
  };
}
