import { describe, expect, it } from 'vitest';
import {
  healthUrlFor,
  WAKE_MAX_WAIT_MS,
  WAKE_POLL_INTERVAL_MS,
  WAKE_SLOW_AFTER_MS,
  type WakeDeps,
  waitForRealtime,
} from './realtime-wake';

describe('healthUrlFor', () => {
  it.each([
    ['ws://localhost:4000', 'http://localhost:4000/health'],
    ['wss://cue-realtime.onrender.com', 'https://cue-realtime.onrender.com/health'],
    ['wss://x.onrender.com/ws?x=1', 'https://x.onrender.com/health'],
  ])('%s → %s', (ws, http) => {
    expect(healthUrlFor(ws)).toBe(http);
  });
});

type Answer = { status: number; body: unknown } | 'network-error' | { hangMs: number };

/** Fake time and a server that answers from a script (the last answer repeats). */
function harness(answers: Answer[]) {
  let t = 0;
  let calls = 0;
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  const runTimers = () => {
    for (const timer of timers) {
      if (!timer.cancelled && timer.at <= t) {
        timer.cancelled = true;
        timer.fn();
      }
    }
  };
  const advance = (ms: number) => {
    t += ms;
    runTimers();
  };
  const deps: WakeDeps = {
    now: () => t,
    sleep: (ms) => {
      advance(ms);
      return Promise.resolve();
    },
    schedule: (fn, ms) => {
      const timer = { at: t + ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    timeout: () => new AbortController().signal,
    fetch: () => {
      const a = answers[Math.min(calls, answers.length - 1)] ?? 'network-error';
      calls++;
      if (a === 'network-error') {
        advance(100);
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      if ('hangMs' in a) {
        advance(a.hangMs); // e.g. Render holding the request while it starts
        return Promise.resolve(Response.json({ status: 'ok' }));
      }
      advance(50);
      return Promise.resolve(Response.json(a.body, { status: a.status }));
    },
  };
  return { deps, calls: () => calls, now: () => t };
}

const OK = { status: 200, body: { status: 'ok' } };

describe('waitForRealtime', () => {
  it('returns at once, with no banner, when the server is already up', async () => {
    const h = harness([OK]);
    let slow = 0;
    const r = await waitForRealtime(
      'http://x/health',
      { onSlow: () => slow++, isCancelled: () => false },
      h.deps,
    );
    expect(r).toBe('up');
    expect(slow).toBe(0);
    expect(h.calls()).toBe(1);
  });

  it('shows the waking banner once while it polls, then reports up', async () => {
    const h = harness(['network-error', 'network-error', OK]);
    let slow = 0;
    const r = await waitForRealtime(
      'http://x/health',
      { onSlow: () => slow++, isCancelled: () => false },
      h.deps,
    );
    expect(r).toBe('up');
    expect(slow).toBe(1);
    expect(h.calls()).toBe(3);
    expect(h.now()).toBeGreaterThanOrEqual(2 * WAKE_POLL_INTERVAL_MS);
  });

  it('shows the banner while a single request is held open by a waking server', async () => {
    const h = harness([{ hangMs: 40_000 }]);
    let slow = 0;
    const r = await waitForRealtime(
      'http://x/health',
      { onSlow: () => slow++, isCancelled: () => false },
      h.deps,
    );
    expect(r).toBe('up');
    expect(slow).toBe(1);
    expect(h.now()).toBeGreaterThan(WAKE_SLOW_AFTER_MS);
  });

  it("doesn't count a page that isn't our server's health JSON (Render's waking page)", async () => {
    const h = harness([{ status: 200, body: { html: true } }, { status: 502, body: {} }, OK]);
    const r = await waitForRealtime(
      'http://x/health',
      { onSlow: () => undefined, isCancelled: () => false },
      h.deps,
    );
    expect(r).toBe('up');
    expect(h.calls()).toBe(3);
  });

  it('gives up after the maximum wait', async () => {
    const h = harness(['network-error']);
    const r = await waitForRealtime(
      'http://x/health',
      { onSlow: () => undefined, isCancelled: () => false },
      h.deps,
    );
    expect(r).toBe('timeout');
    expect(h.now()).toBeGreaterThanOrEqual(WAKE_MAX_WAIT_MS);
  });

  it('stops when the page is closed, without showing a banner afterwards', async () => {
    const h = harness(['network-error']);
    let cancelled = false;
    let slow = 0;
    const p = waitForRealtime(
      'http://x/health',
      {
        onSlow: () => {
          slow++;
          cancelled = true; // the page closes right after the banner appears
        },
        isCancelled: () => cancelled,
      },
      h.deps,
    );
    expect(await p).toBe('cancelled');
    expect(slow).toBe(1);
  });
});
