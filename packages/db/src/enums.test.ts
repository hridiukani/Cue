import { SuggestionFailureReasonSchema, SuggestionSkipReasonSchema } from '@cue/shared';
import { describe, expect, it } from 'vitest';
import { suggestionFailureReasonEnum, suggestionSkipReasonEnum } from './schema/enums';

describe('database enums mirror the shared zod schemas', () => {
  it('suggestion_failure_reason', () => {
    expect(suggestionFailureReasonEnum.enumValues).toEqual(SuggestionFailureReasonSchema.options);
  });

  it('suggestion_skip_reason', () => {
    expect(suggestionSkipReasonEnum.enumValues).toEqual(SuggestionSkipReasonSchema.options);
  });
});
