/** Injected so tests run offline against canned responses. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number) => Promise<void>;

export const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${String(status)} for ${url}`);
    this.name = 'HttpError';
  }
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * fetch with retries for transient failures (network errors, 429, 5xx), using
 * exponential backoff and honoring Retry-After. Returns the final response,
 * even if it's an error status; callers decide what a 401/403/404 means.
 */
export async function fetchWithRetry(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit = {},
  {
    retries = 3,
    baseDelayMs = 500,
    sleep = realSleep,
  }: { retries?: number; baseDelayMs?: number; sleep?: SleepFn } = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchFn(url, init);
      if (!RETRYABLE.has(res.status) || attempt >= retries) return res;
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : baseDelayMs * 2 ** attempt,
      );
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
}
