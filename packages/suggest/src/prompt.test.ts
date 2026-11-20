import { describe, expect, it } from 'vitest';
import {
  buildSuggestionMessages,
  cleanSuggestion,
  hasPreamble,
  lineCount,
  isKnownPromptVersion,
  MAX_SUGGESTION_WORDS,
  PROMPT_VERSION,
  PROMPT_VERSION_NO_PLAYBOOK,
  PROMPT_VERSION_V1,
  PROMPT_VERSION_V2,
  type PlaybookForPrompt,
  renderPlaybook,
  slidingWindow,
  stripSuggestion,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_V1,
  SYSTEM_PROMPT_V2,
  SYSTEM_PROMPTS,
  type WindowUtterance,
  WINDOW_SIZE,
} from './prompt';

const PLAYBOOK: PlaybookForPrompt = {
  name: 'Tallyforge outbound',
  productDescription: 'Automates invoice matching.',
  idealCustomer: 'Mid-market finance teams.',
  objections: [
    { objection: 'Too expensive', good_response: 'Compare to the cost of manual matching.' },
  ],
  toneNotes: 'Consultative.',
};

const history = (n: number): WindowUtterance[] =>
  Array.from({ length: n }, (_, i) => ({
    speaker: i % 2 === 0 ? 'rep' : 'prospect',
    text: `line ${String(i)}`,
  }));

describe('buildSuggestionMessages', () => {
  it('puts the static system prompt first, then the playbook, then the conversation', () => {
    const { messages, promptVersion } = buildSuggestionMessages({
      playbook: PLAYBOOK,
      history: history(3),
    });
    expect(messages.map((m) => m.role)).toEqual(['system', 'system', 'user']);
    expect(messages[0]?.content).toBe(SYSTEM_PROMPT);
    expect(messages[1]?.content).toContain('Tallyforge outbound');
    expect(messages[2]?.content).toContain('Prospect: line 1');
    expect(promptVersion).toBe(PROMPT_VERSION);
  });

  it('keeps the leading messages byte-identical across turns (prefix caching)', () => {
    const a = buildSuggestionMessages({ playbook: PLAYBOOK, history: history(3) }).messages;
    const b = buildSuggestionMessages({ playbook: PLAYBOOK, history: history(9) }).messages;
    expect(b.slice(0, 2)).toEqual(a.slice(0, 2));
    expect(b[2]).not.toEqual(a[2]);
  });

  it('includes only the last 12 utterances, oldest first, ending with the trigger', () => {
    const { messages } = buildSuggestionMessages({ playbook: null, history: history(20) });
    const lines = (messages.at(-1)?.content ?? '')
      .split('\n')
      .filter((l) => /^(Rep|Prospect):/.test(l));
    expect(lines).toHaveLength(WINDOW_SIZE);
    expect(lines[0]).toBe('Rep: line 8');
    expect(lines.at(-1)).toBe('Prospect: line 19');
  });

  it('works without a playbook and records a different prompt version', () => {
    const { messages, promptVersion } = buildSuggestionMessages({
      playbook: null,
      history: history(2),
    });
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(promptVersion).toBe(PROMPT_VERSION_NO_PLAYBOOK);
  });

  it('builds a named prompt version from the registry, and refuses unknown ones', () => {
    expect(isKnownPromptVersion(PROMPT_VERSION)).toBe(true);
    expect(SYSTEM_PROMPTS[PROMPT_VERSION]).toBe(SYSTEM_PROMPT);
    const named = buildSuggestionMessages({
      playbook: PLAYBOOK,
      history: history(2),
      promptVersion: PROMPT_VERSION,
    });
    expect(named).toEqual(buildSuggestionMessages({ playbook: PLAYBOOK, history: history(2) }));
    expect(isKnownPromptVersion('suggest-v0')).toBe(false);
    expect(isKnownPromptVersion('toString')).toBe(false); // not fooled by Object.prototype
    expect(() =>
      buildSuggestionMessages({ playbook: null, history: history(1), promptVersion: 'nope' }),
    ).toThrow(/Unknown prompt version "nope"\. Known: suggest-v1, suggest-v2/);
  });

  it('uses suggest-v2 in production and keeps suggest-v1 in the registry (old runs stay reproducible)', () => {
    expect(PROMPT_VERSION).toBe('suggest-v2'); // moved after the 2026-11-20 eval compare
    expect(PROMPT_VERSION_NO_PLAYBOOK).toBe('suggest-v2/no-playbook');
    expect(SYSTEM_PROMPT).toBe(SYSTEM_PROMPT_V2);
    expect(Object.keys(SYSTEM_PROMPTS)).toEqual(['suggest-v1', 'suggest-v2']);
    expect(SYSTEM_PROMPTS[PROMPT_VERSION_V1]).toBe(SYSTEM_PROMPT_V1);
    expect(SYSTEM_PROMPT_V1).toMatch(/^You are Cue, a real-time coach/);
    expect(SYSTEM_PROMPTS[PROMPT_VERSION_V2]).toBe(SYSTEM_PROMPT_V2);
  });

  it('still builds suggest-v1 on request', () => {
    const { messages, promptVersion } = buildSuggestionMessages({
      playbook: PLAYBOOK,
      history: history(2),
      promptVersion: PROMPT_VERSION_V1,
    });
    expect(promptVersion).toBe('suggest-v1');
    expect(messages[0]?.content).toBe(SYSTEM_PROMPT_V1);
  });

  it('suggest-v2 states the word limit first and asks for a word-count self-check', () => {
    const firstLine = SYSTEM_PROMPT_V2.split('\n')[0] ?? '';
    expect(firstLine).toMatch(
      new RegExp(`^HARD LIMIT: .*at most ${String(MAX_SUGGESTION_WORDS)} words`),
    );
    expect(SYSTEM_PROMPT_V2.trimEnd().split('\n').at(-1)).toMatch(/count the words in your line/);
    expect(SYSTEM_PROMPT_V2).toMatch(/FIRST acknowledge it .* THEN redirect/);
  });

  it('builds suggest-v2 messages in the same cache-friendly order, with or without a playbook', () => {
    const withPlaybook = buildSuggestionMessages({
      playbook: PLAYBOOK,
      history: history(3),
      promptVersion: PROMPT_VERSION_V2,
    });
    expect(withPlaybook.promptVersion).toBe('suggest-v2');
    expect(withPlaybook.messages[0]?.content).toBe(SYSTEM_PROMPT_V2);
    expect(withPlaybook.messages.map((m) => m.role)).toEqual(['system', 'system', 'user']);
    const without = buildSuggestionMessages({
      playbook: null,
      history: history(3),
      promptVersion: PROMPT_VERSION_V2,
    });
    expect(without.promptVersion).toBe('suggest-v2/no-playbook');
  });
});

describe('renderPlaybook', () => {
  it('includes product, ICP, each objection with its response, and tone', () => {
    const text = renderPlaybook(PLAYBOOK);
    expect(text).toContain('Product: Automates invoice matching.');
    expect(text).toContain('Ideal customer: Mid-market finance teams.');
    expect(text).toContain('"Too expensive" → Compare to the cost of manual matching.');
    expect(text).toContain('Tone: Consultative.');
  });

  it('omits empty sections', () => {
    const text = renderPlaybook({ ...PLAYBOOK, objections: [], toneNotes: null });
    expect(text).not.toContain('Objections');
    expect(text).not.toContain('Tone');
  });
});

describe('slidingWindow', () => {
  it('returns everything when shorter than the window', () => {
    expect(slidingWindow([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe('cleanSuggestion', () => {
  it.each([
    [
      'Ask what manual matching costs them each month.',
      'Ask what manual matching costs them each month.',
    ],
    ['"Ask what it costs them."', 'Ask what it costs them.'],
    ['Rep: Ask what it costs them.', 'Ask what it costs them.'],
    ["Sure! Here's a suggestion: Ask what it costs them.", 'Ask what it costs them.'],
    ['Suggestion - Ask about their timeline.', 'Ask about their timeline.'],
    ['Ask about their timeline.\nThis works because…', 'Ask about their timeline.'],
    ['   ', ''],
  ])('%j → %j', (raw, expected) => {
    expect(cleanSuggestion(raw)).toBe(expected);
  });

  it(`caps the line at ${String(MAX_SUGGESTION_WORDS)} words`, () => {
    const long = Array.from({ length: 40 }, (_, i) => `w${String(i)}`).join(' ');
    expect(cleanSuggestion(long).split(' ')).toHaveLength(MAX_SUGGESTION_WORDS);
  });

  it('does not strip a line that merely starts with a word like "Okay"', () => {
    expect(cleanSuggestion('Okay, what would it take to try it next month?')).toBe(
      'Okay, what would it take to try it next month?',
    );
  });
});

describe('stripSuggestion, hasPreamble, lineCount', () => {
  it('cleans like cleanSuggestion but never cuts the line', () => {
    const long = Array.from({ length: 25 }, (_, i) => `w${String(i)}`).join(' ');
    expect(stripSuggestion(`Rep: ${long}`).split(' ')).toHaveLength(25);
    expect(cleanSuggestion(`Rep: ${long}`).split(' ')).toHaveLength(MAX_SUGGESTION_WORDS);
    expect(stripSuggestion('  "Ask   about the budget."  \nWhy: it helps')).toBe(
      'Ask about the budget.',
    );
  });

  it('spots a preamble on the first line only', () => {
    expect(hasPreamble("Sure! Here's a line: Ask about budget.")).toBe(true);
    expect(hasPreamble('Rep: Ask about budget.')).toBe(true);
    expect(hasPreamble('Ask about budget.\nRep: later')).toBe(false);
    expect(hasPreamble('Okay, what does the team use today?')).toBe(false);
  });

  it('counts non-empty lines', () => {
    expect(lineCount('one')).toBe(1);
    expect(lineCount('one\n\n two \r\nthree')).toBe(3);
    expect(lineCount('  \n')).toBe(0);
  });
});
