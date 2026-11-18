import type { LlmRequest } from './llm';

/**
 * Sampling settings for a suggestion. Shared by the realtime engine and the
 * offline eval harness, so evals measure the same requests production sends.
 */
export const SUGGESTION_SAMPLING = { maxTokens: 48, temperature: 0.3 } as const;

/** Hidden-reasoning budget for reasoning models; the visible line is still capped at 20 words. */
export const REASONING_MAX_TOKENS = 512;

/** Reasoning models think in hidden tokens before writing the visible answer. */
export function isReasoningModel(model: string): boolean {
  return /(^|\/)gpt-oss/i.test(model);
}

/**
 * Per-model request settings. A reasoning model (e.g. openai/gpt-oss-20b) spends
 * tokens on hidden reasoning first: with a 48-token budget it returned no answer
 * at all (checked against Groq, 2026-11-17). So it gets low reasoning effort, a
 * larger budget, and its reasoning kept out of the stream. Generation still stops
 * early once the visible line reaches 20 words.
 */
export function modelRequestSettings(
  model: string,
  maxTokens: number,
): Pick<LlmRequest, 'maxTokens' | 'reasoningEffort' | 'includeReasoning'> {
  if (!isReasoningModel(model)) return { maxTokens };
  return {
    maxTokens: Math.max(maxTokens, REASONING_MAX_TOKENS),
    reasoningEffort: 'low',
    includeReasoning: false,
  };
}
