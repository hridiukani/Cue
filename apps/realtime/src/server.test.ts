import { createDb } from '@cue/db';
import type { LlmClient } from '@cue/suggest';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { buildServer, type ServerDeps } from './server';

const CONFIG = loadConfig({
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://cue:cue@localhost:5434/cue',
  REALTIME_TICKET_SECRET: 's'.repeat(32),
});

// postgres.js connects lazily; port 1 refuses at once, so "unreachable" is fast.
const { db, close } = createDb('postgres://unused:unused@127.0.0.1:1/unused', { max: 1 });
const servers: { close: () => Promise<unknown> }[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
  await close();
});

function server(deps: Partial<ServerDeps> = {}) {
  const { app } = buildServer(CONFIG, { db, llm: null, ...deps });
  servers.push(app);
  return app;
}

const fakeLlm: LlmClient = {
  name: 'fake',
  // eslint-disable-next-line require-yield
  async *stream() {
    await Promise.resolve();
    return;
  },
};

describe('GET /health (liveness)', () => {
  it('returns ok without touching the database', async () => {
    let dbChecks = 0;
    const app = server({
      checkDb: () => {
        dbChecks++;
        return Promise.reject(new Error('down'));
      },
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(dbChecks).toBe(0); // a paused database must not fail Render's health check
  });
});

describe('GET /health/ready (readiness)', () => {
  it('is 200 when the database answers, and says whether suggestions are on', async () => {
    const res = await server({ checkDb: () => Promise.resolve(), llm: fakeLlm }).inject({
      method: 'GET',
      url: '/health/ready',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'ok', suggestions: 'on' });
  });

  it('is 503 with db "unreachable" when the database refuses (e.g. Supabase paused)', async () => {
    const res = await server().inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', db: 'unreachable', suggestions: 'off' });
  });
});
