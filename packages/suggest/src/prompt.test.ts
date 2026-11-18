import { describe, expect, it } from 'vitest';
import {
  buildSuggestionMessages,
  cleanSuggestion,
  isKnownPromptVersion,
  MAX_SUGGESTION_WORDS,
  PROMPT_VERSION,
  PROMPT_VERSION_NO_PLAYBOOK,
  type PlaybookForPrompt,
  renderPlaybook,
  slidingWindow,
  SYSTEM_PROMPT,
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
    ).toThrow(/Unknown prompt version "nope"\. Known: suggest-v1/);
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
