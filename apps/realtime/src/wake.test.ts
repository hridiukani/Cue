import { describe, expect, it } from 'vitest';
import { httpOrigin, isAwake, wake, WAKE_TIMEOUT_MS, type WakeIo } from './wake';

type Handler = (url: string) => Response | 'down';

function io(handler: Handler) {
  let t = 0;
  const lines: string[] = [];
  const calls: string[] = [];
  const fakeIo: WakeIo = {
    now: () => t,
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
    log: (l) => lines.push(l),
    fetch: (url) => {
      calls.push(url);
      const r = handler(url);
      return r === 'down' ? Promise.reject(new TypeError('fetch failed')) : Promise.resolve(r);
    },
  };
  return { io: fakeIo, lines, calls };
}

const ready = (db: 'ok' | 'unreachable', suggestions: 'on' | 'off' = 'on') =>
  Response.json(
    { status: db === 'ok' ? 'ok' : 'degraded', db, suggestions },
    { status: db === 'ok' ? 200 : 503 },
  );

describe('httpOrigin', () => {
  it.each([
    ['wss://cue-realtime.onrender.com', 'https://cue-realtime.onrender.com'],
    ['ws://localhost:4000/ws', 'http://localhost:4000'],
    ['https://cue.vercel.app/', 'https://cue.vercel.app'],
  ])('%s → %s', (url, origin) => {
    expect(httpOrigin(url)).toBe(origin);
  });

  it('refuses other schemes', () => {
    expect(() => httpOrigin('ftp://x')).toThrow(/Not an http/);
  });
});

describe('wake', () => {
  it('waits for a sleeping server, then reports database, suggestions and web', async () => {
    let healthCalls = 0;
    const h = io((url) => {
      if (url.endsWith('/health'))
        return ++healthCalls < 3 ? 'down' : Response.json({ status: 'ok' });
      if (url.endsWith('/health/ready')) return ready('ok');
      if (url.endsWith('/signin')) return new Response('<html>', { status: 200 });
      return 'down';
    });
    const r = await wake({ realtime: 'wss://rt.example', web: 'https://web.example' }, h.io);
    expect(r).toEqual({ realtime: 'up', db: 'ok', suggestions: 'on', web: 'ok' });
    expect(isAwake(r)).toBe(true);
    expect(h.calls.filter((c) => c === 'https://rt.example/health')).toHaveLength(3);
  });

  it('points at Supabase when the database is unreachable', async () => {
    const h = io((url) =>
      url.endsWith('/health/ready') ? ready('unreachable', 'off') : Response.json({ status: 'ok' }),
    );
    const r = await wake({ realtime: 'wss://rt.example', web: null }, h.io);
    expect(r).toMatchObject({
      realtime: 'up',
      db: 'unreachable',
      suggestions: 'off',
      web: 'skipped',
    });
    expect(isAwake(r)).toBe(false);
    expect(h.lines.join('\n')).toMatch(/Supabase project paused\? Restore it/);
    expect(h.lines.join('\n')).toMatch(/GROQ_API_KEY is not set/);
  });

  it('gives up after the timeout and skips the readiness check', async () => {
    const h = io(() => 'down');
    const r = await wake({ realtime: 'wss://rt.example', web: null }, h.io);
    expect(r.realtime).toBe('timeout');
    expect(r.db).toBe('unknown');
    expect(h.calls.some((c) => c.endsWith('/health/ready'))).toBe(false);
    expect(h.lines.join('\n')).toContain(`not up after ${String(WAKE_TIMEOUT_MS / 1000)} s`);
  });

  it("doesn't mistake another page for the server's health JSON", async () => {
    const h = io((url) =>
      url.endsWith('/health') ? new Response('<html>waking</html>', { status: 200 }) : 'down',
    );
    expect((await wake({ realtime: 'wss://rt.example', web: null }, h.io)).realtime).toBe(
      'timeout',
    );
  });

  it('reports a broken web deployment', async () => {
    const h = io((url) => {
      if (url.endsWith('/health')) return Response.json({ status: 'ok' });
      if (url.endsWith('/health/ready')) return ready('ok');
      return new Response('', { status: 500 });
    });
    const r = await wake({ realtime: 'wss://rt.example', web: 'https://web.example' }, h.io);
    expect(r.web).toBe('error');
    expect(isAwake(r)).toBe(false);
  });
});
