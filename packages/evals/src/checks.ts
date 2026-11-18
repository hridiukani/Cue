import {
  cleanSuggestion,
  hasPreamble,
  lineCount,
  MAX_SUGGESTION_WORDS,
  stripSuggestion,
  wordCount,
} from '@cue/suggest';

/**
 * Deterministic checks: no model involved, so they're exact and free.
 * They look at the model's raw output (what it wrote) and the shown line
 * (what production would put in front of the rep after cleanSuggestion).
 */

export type CheckId =
  'non_empty' | 'max_words' | 'one_line' | 'no_preamble' | 'no_placeholders' | 'no_banned_phrases';

export interface CheckResult {
  id: CheckId;
  pass: boolean;
  detail?: string;
}

export interface DeterministicResult {
  /** What the rep would see (cut to 20 words, like production). */
  shown: string;
  /** Words in the model's own line, before production's 20-word cut. */
  words: number;
  checks: CheckResult[];
  pass: boolean;
}

/** Banned in every case: assistant-speak and meta-talk a rep can't say on a call. */
export const GLOBAL_BANNED_PHRASES = [
  'as an ai',
  'language model',
  'i cannot help',
  'here is a suggestion',
  'suggested line',
  'sales rep:',
] as const;

/** Template slots the model forgot to fill: "[Name]", "{company}", "<product>". */
const PLACEHOLDER = /\[[^\]]{1,40}\]|\{[^}]{1,40}\}|<[^>]{1,40}>/;

/** Case-insensitive phrase match on word boundaries ("price" doesn't match "priceless"). */
export function containsPhrase(text: string, phrase: string): boolean {
  const escaped = phrase
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  const startB = /^\w/.test(phrase.trim()) ? '\\b' : '';
  const endB = /\w$/.test(phrase.trim()) ? '\\b' : '';
  return new RegExp(`${startB}${escaped}${endB}`, 'i').test(text);
}

export function runDeterministicChecks(
  raw: string,
  caseBannedPhrases: readonly string[] = [],
): DeterministicResult {
  const own = stripSuggestion(raw);
  const shown = cleanSuggestion(raw);
  const words = wordCount(own);
  const banned = [...GLOBAL_BANNED_PHRASES, ...caseBannedPhrases].filter((p) =>
    containsPhrase(raw, p),
  );
  const placeholder = PLACEHOLDER.exec(shown);
  const lines = lineCount(raw);

  const checks: CheckResult[] = [
    { id: 'non_empty', pass: shown.length > 0, ...(shown ? {} : { detail: 'no usable line' }) },
    {
      id: 'max_words',
      pass: words <= MAX_SUGGESTION_WORDS,
      ...(words > MAX_SUGGESTION_WORDS
        ? {
            detail: `${String(words)} words; production cuts it at ${String(MAX_SUGGESTION_WORDS)}`,
          }
        : {}),
    },
    {
      id: 'one_line',
      pass: lines <= 1,
      ...(lines > 1 ? { detail: `${String(lines)} lines; the rep only sees the first` } : {}),
    },
    {
      id: 'no_preamble',
      pass: !hasPreamble(raw),
      ...(hasPreamble(raw) ? { detail: 'starts with a label or preamble' } : {}),
    },
    {
      id: 'no_placeholders',
      pass: placeholder === null,
      ...(placeholder ? { detail: `unfilled placeholder ${placeholder[0]}` } : {}),
    },
    {
      id: 'no_banned_phrases',
      pass: banned.length === 0,
      ...(banned.length > 0
        ? { detail: `contains ${banned.map((b) => `"${b}"`).join(', ')}` }
        : {}),
    },
  ];
  return { shown, words, checks, pass: checks.every((c) => c.pass) };
}
