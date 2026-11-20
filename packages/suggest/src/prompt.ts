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

export const WINDOW_SIZE = 12;
export const MAX_SUGGESTION_WORDS = 20;

/** The first prompt (production 2026-11-17 to 2026-11-20). Kept so old runs stay reproducible. */
export const PROMPT_VERSION_V1 = 'suggest-v1';

export const SYSTEM_PROMPT_V1 = `You are Cue, a real-time coach whispering to a sales rep during a live call.
The prospect just finished speaking. Write the ONE next line the rep should say.

Rules:
- Output only the line itself: no preamble, no quotes, no labels, no explanation.
- At most ${String(MAX_SUGGESTION_WORDS)} words, one sentence, plain spoken English the rep can say verbatim.
- Respond to what the prospect actually just said. Prefer a short, specific question that moves the deal forward.
- If the prospect raised an objection that the playbook covers, use the playbook's good response, in your own words.
- Never invent facts, prices, features or customer names that aren't in the playbook or the conversation.
- Match the playbook's tone notes when given.`;

/**
 * suggest-v2 fixes the two defects the first eval baseline found (2026-11-18,
 * 43 cases × 3):
 * - 19 of 129 lines ran past 20 words, so production cut them mid-sentence:
 *   the limit now comes FIRST, with a word-count self-check (gpt-oss reasons
 *   in hidden tokens before answering, so it can actually count);
 * - price objections passed 0%: the line jumped to a question without
 *   acknowledging the concern. v2 says to acknowledge first, then redirect.
 *
 * Production default since 2026-11-20, after `pnpm eval compare` (43 cases × 3,
 * every line graded): pass rate 43.4% → 62.0%, over-20-word lines 29 → 4 of
 * 129, price objections 0% → 66.7%. Costs: first token p50/p95 +94/+200 ms
 * (the self-check is hidden reasoning, ~11 → ~100 tokens), cost per 1,000
 * +59%, and competitor cases fell 55.6% → 33.3%.
 */
export const PROMPT_VERSION_V2 = 'suggest-v2';

export const SYSTEM_PROMPT_V2 = `HARD LIMIT: the line you write is at most ${String(MAX_SUGGESTION_WORDS)} words. Anything longer is cut off mid-sentence on the rep's screen.

You are Cue, a real-time coach whispering to a sales rep during a live call.
The prospect just finished speaking. Write the ONE next line the rep should say.

Rules:
- Output only the line itself: no preamble, no quotes, no labels, no explanation.
- Plain spoken English the rep can say verbatim: one sentence, or a short acknowledgement plus one question.
- If the prospect raised a concern or objection (price, cost, budget, timing, risk, an existing tool), FIRST acknowledge it in a few words, in their terms, THEN redirect: a short question, or the playbook's good response in your own words. Never skip, dismiss or argue with the concern.
- Otherwise respond to what the prospect actually just said. Prefer a short, specific question that moves the deal forward.
- Never invent facts, prices, discounts, features or customer names that aren't in the playbook or the conversation.
- Match the playbook's tone notes when given.

Before you answer, count the words in your line. If there are more than ${String(MAX_SUGGESTION_WORDS)}, shorten it until there are ${String(MAX_SUGGESTION_WORDS)} or fewer.`;

/** What production sends. Change it only after `pnpm eval compare` old vs new. */
export const PROMPT_VERSION = PROMPT_VERSION_V2;
export const PROMPT_VERSION_NO_PLAYBOOK = `${PROMPT_VERSION}/no-playbook`;
export const SYSTEM_PROMPT = SYSTEM_PROMPT_V2;

/**
 * Every system prompt by version. When SYSTEM_PROMPT changes, add the new
 * version here and keep the old entry, so `pnpm eval --prompt-version <old>`
 * can still compare it with the new one.
 */
export const SYSTEM_PROMPTS: Readonly<Record<string, string>> = {
  [PROMPT_VERSION_V1]: SYSTEM_PROMPT_V1,
  [PROMPT_VERSION_V2]: SYSTEM_PROMPT_V2,
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
 * The model's line as written: first non-empty line, without a leading
 * preamble or wrapping quotes, whitespace collapsed. NOT cut to 20 words
 * (evals use it to see whether the model ran long).
 */
export function stripSuggestion(raw: string): string {
  let text = firstLine(raw);
  for (let i = 0; i < 2; i++) text = text.replace(PREAMBLE, '').replace(QUOTES, '').trim();
  return text.split(/\s+/).filter(Boolean).join(' ');
}

/** True if the first line starts with a label or preamble ("Rep:", "Sure! Here's a line:"). */
export function hasPreamble(raw: string): boolean {
  return PREAMBLE.test(firstLine(raw));
}

/** The first non-empty line, trimmed. */
export function firstLine(raw: string): string {
  return (raw.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '').trim();
}

/** How many non-empty lines the model wrote (the rep only ever sees the first). */
export function lineCount(raw: string): number {
  return raw.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
}

/**
 * Turn raw model output into the line shown to the rep: first line only, no
 * preamble or wrapping quotes, whitespace collapsed, at most 20 words.
 * Returns '' if nothing usable is left.
 */
export function cleanSuggestion(raw: string): string {
  return stripSuggestion(raw).split(' ').filter(Boolean).slice(0, MAX_SUGGESTION_WORDS).join(' ');
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
