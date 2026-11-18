import type { TokenUsage } from '@cue/suggest';

/**
 * USD per 1M tokens, as published on the provider's models page. Never guess
 * a price: a model missing here reports its cost as unknown.
 *
 * Hidden reasoning tokens are billed as output (they're part of
 * completion_tokens). Cached-input discounts aren't applied, so these costs
 * are an upper bound.
 */
export const PRICING_SOURCE = {
  url: 'https://console.groq.com/docs/models',
  checkedOn: '2026-11-17',
} as const;

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'openai/gpt-oss-20b': { inputPerMTok: 0.075, outputPerMTok: 0.3 },
  'openai/gpt-oss-120b': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  'qwen/qwen3.8-27b': { inputPerMTok: 0.8, outputPerMTok: 4.0 }, // a preview model on Groq
};

export function priceOf(model: string): ModelPrice | null {
  return Object.hasOwn(PRICES, model) ? (PRICES[model] ?? null) : null;
}

/** Cost of one request in USD, or null if the model's price or the usage is unknown. */
export function costUsd(model: string, usage: TokenUsage | null): number | null {
  const price = priceOf(model);
  if (!price || !usage) return null;
  return (
    (usage.promptTokens * price.inputPerMTok + usage.completionTokens * price.outputPerMTok) /
    1_000_000
  );
}
