import { describe, expect, it } from 'vitest';
import { isReasoningModel, modelRequestSettings, REASONING_MAX_TOKENS } from './model-settings';

describe('modelRequestSettings', () => {
  it('leaves non-reasoning models alone', () => {
    expect(isReasoningModel('llama-3.1-8b-instant')).toBe(false);
    expect(modelRequestSettings('llama-3.1-8b-instant', 48)).toEqual({ maxTokens: 48 });
  });

  it.each(['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'gpt-oss-20b'])(
    'treats %s as a reasoning model',
    (model) => {
      expect(isReasoningModel(model)).toBe(true);
      expect(modelRequestSettings(model, 48)).toEqual({
        maxTokens: REASONING_MAX_TOKENS,
        reasoningEffort: 'low',
        includeReasoning: false,
      });
    },
  );
});
