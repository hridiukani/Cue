import { z } from 'zod';

/**
 * `pnpm wake -- --realtime <url> [--web <url>]`: wake a free-tier deployment
 * and say what's still asleep (docs/deploy.md, "Wake everything up").
 *
 * 1. Poll the realtime server's /health until it answers (Render's free tier
 *    takes up to about a minute to start after 15 idle minutes).
 * 2. Ask /health/ready whether it can reach the database (a paused Supabase
 *    project shows up here) and whether suggestions are on.
 * 3. Optionally load the web app's sign-in page.
 */

export const WAKE_TIMEOUT_MS = 120_000;
const POLL_MS = 3000;

const HealthSchema = z.object({ status: z.literal('ok') });
const ReadySchema = z.object({
  status: z.enum(['ok', 'degraded']),
  db: z.enum(['ok', 'unreachable']),
  suggestions: z.enum(['on', 'off']),
});

export interface WakeIo {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export interface WakeReport {
  realtime: 'up' | 'timeout';
  db: 'ok' | 'unreachable' | 'unknown';
  suggestions: 'on' | 'off' | 'unknown';
  web: 'ok' | 'error' | 'skipped';
}

/** http(s) origin from a ws(s):// or http(s):// URL, without a trailing slash. */
export function httpOrigin(url: string): string {
  const u = new URL(url);
  if (u.protocol === 'wss:') u.protocol = 'https:';
  if (u.protocol === 'ws:') u.protocol = 'http:';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Not an http(s) or ws(s) URL: ${url}`);
  }
  return u.origin;
}

async function json(io: WakeIo, url: string): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await io.fetch(url, { signal: AbortSignal.timeout(15_000) });
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch {
    return null;
  }
}

export async function wake(
  opts: { realtime: string; web: string | null },
  io: WakeIo,
): Promise<WakeReport> {
  const base = httpOrigin(opts.realtime);
  const report: WakeReport = {
    realtime: 'timeout',
    db: 'unknown',
    suggestions: 'unknown',
    web: 'skipped',
  };

  io.log(`1. Realtime server: waking ${base}/health (free tier: up to ~1 min)…`);
  const deadline = io.now() + WAKE_TIMEOUT_MS;
  for (;;) {
    const r = await json(io, `${base}/health`);
    if (r?.status === 200 && HealthSchema.safeParse(r.body).success) {
      report.realtime = 'up';
      break;
    }
    if (io.now() >= deadline) break;
    await io.sleep(POLL_MS);
  }
  if (report.realtime === 'up') {
    io.log('   up');
  } else {
    io.log(
      `   not up after ${String(WAKE_TIMEOUT_MS / 1000)} s: check the Render dashboard (deploy failed? suspended?)`,
    );
  }

  if (report.realtime === 'up') {
    io.log(`2. Database and suggestions: ${base}/health/ready`);
    const r = await json(io, `${base}/health/ready`);
    const ready = ReadySchema.safeParse(r?.body);
    if (ready.success) {
      report.db = ready.data.db;
      report.suggestions = ready.data.suggestions;
      io.log(
        report.db === 'ok'
          ? '   database: ok'
          : '   database: UNREACHABLE. Is the Supabase project paused? Restore it in the Supabase dashboard, wait until it says healthy, then run this again.',
      );
      io.log(
        report.suggestions === 'on'
          ? '   suggestions: on'
          : '   suggestions: off (GROQ_API_KEY is not set on Render)',
      );
    } else {
      io.log('   unexpected answer from /health/ready');
    }
  }

  if (opts.web) {
    const web = httpOrigin(opts.web);
    io.log(`3. Web app: ${web}/signin`);
    try {
      const res = await io.fetch(`${web}/signin`, { signal: AbortSignal.timeout(30_000) });
      report.web = res.ok ? 'ok' : 'error';
      io.log(res.ok ? '   ok' : `   HTTP ${String(res.status)}: check the Vercel deployment`);
    } catch {
      report.web = 'error';
      io.log('   unreachable: check the Vercel deployment and the URL');
    }
  }
  return report;
}

/** Everything needed for a working demo is up. */
export function isAwake(r: WakeReport): boolean {
  return r.realtime === 'up' && r.db === 'ok' && r.web !== 'error';
}
