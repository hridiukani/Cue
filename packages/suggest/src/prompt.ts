import type { Speaker } from '@cue/shared';

/**
 * Prompt for one suggested next line.
 *
 * ORDER MATTERS for provider-side prefix caching: identical leading tokens can
 * be reused between requests. So the prompt goes from most to least stable:
 *   1. static system prompt (same for every request with this PROMPT_VERSION)
 *   2. playbook (same for the whole session)
 *   3. the sliding window of recent utterances (changes every turn)
 *
 * Changing SYSTEM_PROMPT means bumping PROMPT_VERSION, so stored suggestions
 * always say which prompt produced them.
 */
export const PROMPT_VERSION = 'suggest-v1';
export const PROMPT_VERSION_NO_PLAYBOOK = 'suggest-v1/no-playbook';

export const WINDOW_SIZE = 12;
export const MAX_SUGGESTION_WORDS = 20;

export const SYSTEM_PROMPT = `You are Cue, a real-time coach whispering to a sales rep during a live call.
The prospect just finished speaking. Write the ONE next line the rep should say.

Rules:
- Output only the line itself: no preamble, no quotes, no labels, no explanation.
- At most ${String(MAX_SUGGESTION_WORDS)} words, one sentence, plain spoken English the rep can say verbatim.
- Respond to what the prospect actually just said. Prefer a short, specific question that moves the deal forward.
- If the prospect raised an objection that the playbook covers, use the playbook's good response, in your own words.
- Never invent facts, prices, features or customer names that aren't in the playbook or the conversation.
- Match the playbook's tone notes when given.`;

/**
 * Every system prompt by version. When SYSTEM_PROMPT changes, add the new
 * version here and keep the old entry, so `pnpm eval --prompt-version <old>`
 * can still compare it with the new one.
 */
export const SYSTEM_PROMPTS: Readonly<Record<string, string>> = {
  [PROMPT_VERSION]: SYSTEM_PROMPT,
};

export function isKnownPromptVersion(version: string): boolean {
  return Object.hasOwn(SYSTEM_PROMPTS, version);
}

export interface PlaybookForPrompt {
  name: string;
  productDescription: string;
  idealCustomer: string;
  objections: { objection: string; good_response: string }[];
  toneNotes: string | null;
}

export interface WindowUtterance {
  speaker: Speaker;
  text: string;
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export function renderPlaybook(p: PlaybookForPrompt): string {
  const lines = [
    `Playbook: ${p.name}`,
    `Product: ${p.productDescription}`,
    `Ideal customer: ${p.idealCustomer}`,
  ];
  if (p.objections.length > 0) {
    lines.push('Objections and good responses:');
    for (const o of p.objections) lines.push(`- "${o.objection}" → ${o.good_response}`);
  }
  if (p.toneNotes) lines.push(`Tone: ${p.toneNotes}`);
  return lines.join('\n');
}

const LABEL: Record<Speaker, string> = { rep: 'Rep', prospect: 'Prospect' };

/** The last WINDOW_SIZE utterances, oldest first. */
export function slidingWindow<T>(history: readonly T[], size = WINDOW_SIZE): T[] {
  return history.slice(Math.max(0, history.length - size));
}

export function buildSuggestionMessages(input: {
  playbook: PlaybookForPrompt | null;
  /** Conversation so far, oldest first; the last item is the prospect line that triggered this. */
  history: readonly WindowUtterance[];
  /** Which system prompt to use (default: the current one). Evals pass older ones. */
  promptVersion?: string;
}): { messages: ChatMessage[]; promptVersion: string } {
  const base = input.promptVersion ?? PROMPT_VERSION;
  const system = SYSTEM_PROMPTS[base];
  if (system === undefined) {
    throw new Error(
      `Unknown prompt version "${base}". Known: ${Object.keys(SYSTEM_PROMPTS).join(', ')}`,
    );
  }
  const messages: ChatMessage[] = [{ role: 'system', content: system }];
  if (input.playbook) messages.push({ role: 'system', content: renderPlaybook(input.playbook) });
  const transcript = slidingWindow(input.history)
    .map((u) => `${LABEL[u.speaker]}: ${u.text}`)
    .join('\n');
  messages.push({
    role: 'user',
    content: `Recent conversation (most recent last):\n${transcript}\n\nThe rep's next line:`,
  });
  return {
    messages,
    promptVersion: input.playbook ? base : `${base}/no-playbook`,
  };
}

// Leading labels/preambles models add despite instructions: "Rep:", "Suggestion -", "Sure! Here's…:".
const PREAMBLE =
  /^\s*(?:(?:sure|okay|ok)[,!.]?\s*)?(?:(?:here(?:'s| is)\s+)?(?:a|the|your)?\s*(?:suggested\s+)?(?:line|suggestion|response|reply|answer)\s*[:\-–]\s*|(?:rep|sales\s*rep|you|suggestion)\s*[:\-–]\s*)/i;
const QUOTES = /^["'“”‘’`]+|["'“”‘’`]+$/g;

/**
 * Turn raw model output into the line shown to the rep: first line only, no
 * preamble or wrapping quotes, whitespace collapsed, at most 20 words.
 * Returns '' if nothing usable is left.
 */
export function cleanSuggestion(raw: string): string {
  let text = (raw.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '').trim();
  for (let i = 0; i < 2; i++) text = text.replace(PREAMBLE, '').replace(QUOTES, '').trim();
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(0, MAX_SUGGESTION_WORDS).join(' ');
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
