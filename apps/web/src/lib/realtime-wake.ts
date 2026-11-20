import { z } from 'zod';

/**
 * Waking the realtime server before opening the WebSocket.
 *
 * On Render's free tier the server spins down after 15 minutes without
 * traffic and takes up to about a minute to start again (docs/deploy.md). The
 * reconnect backoff alone gives up sooner, and the rep would just see
 * "Connection lost". So before connecting, poll the server's /health until it
 * answers, and say what's happening if that takes more than a moment.
 */

export const WAKE_SLOW_AFTER_MS = 1500; // no banner when the server is already up
export const WAKE_MAX_WAIT_MS = 90_000; // Render: "up to a minute", plus margin
export const WAKE_POLL_INTERVAL_MS = 2000;
export const WAKE_TRY_TIMEOUT_MS = 10_000;

/** ws://host:4000 → http://host:4000/health; wss://x.onrender.com → https://x.onrender.com/health. */
export function healthUrlFor(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '/health';
  u.search = '';
  u.hash = '';
  return u.toString();
}

// Only our server's own answer counts. Render's "waking up" page while it
// starts has no CORS header and isn't this JSON.
const HealthSchema = z.object({ status: z.literal('ok') });

export interface WakeDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Run fn after ms; returns a cancel function. */
  schedule: (fn: () => void, ms: number) => () => void;
  timeout: (ms: number) => AbortSignal;
}

export type WakeResult = 'up' | 'timeout' | 'cancelled';

export async function waitForRealtime(
  healthUrl: string,
  opts: { onSlow: () => void; isCancelled: () => boolean },
  deps: WakeDeps,
): Promise<WakeResult> {
  const deadline = deps.now() + WAKE_MAX_WAIT_MS;
  let slowShown = false;
  const showSlow = () => {
    if (slowShown || opts.isCancelled()) return;
    slowShown = true;
    opts.onSlow();
  };
  // A sleeping Render service holds the first request open while it starts,
  // so "slow" is decided by a timer, not by a failed try.
  const cancelSlowTimer = deps.schedule(showSlow, WAKE_SLOW_AFTER_MS);
  try {
    for (;;) {
      if (opts.isCancelled()) return 'cancelled';
      if (await isUp(healthUrl, deps)) return 'up';
      showSlow();
      if (deps.now() >= deadline) return 'timeout';
      await deps.sleep(WAKE_POLL_INTERVAL_MS);
    }
  } finally {
    cancelSlowTimer();
  }
}

async function isUp(healthUrl: string, deps: WakeDeps): Promise<boolean> {
  try {
    const res = await deps.fetch(healthUrl, {
      cache: 'no-store',
      signal: deps.timeout(WAKE_TRY_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    return HealthSchema.safeParse(await res.json()).success;
  } catch {
    return false; // network error, CORS refusal, timeout, not JSON: not up yet
  }
}
