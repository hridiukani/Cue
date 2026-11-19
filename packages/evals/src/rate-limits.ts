import type { RateLimitInfo } from './judge';

/**
 * Which provider limits a run hit, saved with the run and printed after it,
 * so "the judge got 429s" comes with WHICH limit: requests or tokens, per
 * minute or per day. Groq names the limit in the 429 message; its headers
 * cover requests per day and tokens per minute only.
 */
export interface RateLimitStats {
  /** 429s by limit kind, for the judge and the model under test. */
  judge: Record<string, number>;
  model: Record<string, number>;
  /** Waits longer than the allowed maximum: the remaining judge calls were left ungraded. */
  gaveUp: number;
  /** The most recent judge 429, with the provider's message and headers. */
  last: RateLimitInfo | null;
}

export const newRateLimitStats = (): RateLimitStats => ({
  judge: {},
  model: {},
  gaveUp: 0,
  last: null,
});

export function recordRateLimit(
  stats: RateLimitStats,
  who: 'model' | 'judge',
  info: RateLimitInfo | null,
  gaveUp: boolean,
): void {
  const kind = info?.kind ?? 'unknown';
  stats[who][kind] = (stats[who][kind] ?? 0) + 1;
  if (gaveUp) stats.gaveUp++;
  if (who === 'judge' && info) stats.last = info;
}

/** Plain lines for the terminal; empty when nothing was rate limited. */
export function describeRateLimits(stats: RateLimitStats): string[] {
  const fmt = (m: Record<string, number>) =>
    Object.entries(m)
      .sort(([, a], [, b]) => b - a)
      .map(([k, n]) => `${k} ×${String(n)}`)
      .join(', ');
  const lines: string[] = [];
  if (Object.keys(stats.judge).length > 0) lines.push(`Judge rate limits hit: ${fmt(stats.judge)}`);
  if (Object.keys(stats.model).length > 0) lines.push(`Model rate limits hit: ${fmt(stats.model)}`);
  if (stats.gaveUp > 0) {
    lines.push(
      `Gave up waiting ${String(stats.gaveUp)} time(s): the provider asked for a longer wait than allowed (--max-wait).`,
    );
  }
  const last = stats.last;
  if (last) {
    const h = last.headers;
    lines.push(
      `Last judge 429: ${last.kind}; retry after ${last.retryAfterMs === null ? '?' : `${String(Math.round(last.retryAfterMs / 1000))} s`}; headers: requests/day ${h.remainingRequests ?? '?'} of ${h.limitRequests ?? '?'} left, tokens/min ${h.remainingTokens ?? '?'} of ${h.limitTokens ?? '?'} left`,
    );
    if (last.message) lines.push(`  Provider said: ${last.message}`);
  }
  return lines;
}
