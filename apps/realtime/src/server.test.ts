import { createDb } from '@cue/db';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { buildServer } from './server';

describe('GET /health', () => {
  // postgres.js connects lazily, so no database is needed for this test.
  const { db, close } = createDb('postgres://unused:unused@127.0.0.1:1/unused');
  const { app } = buildServer(
    loadConfig({
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgres://cue:cue@localhost:5434/cue',
      REALTIME_TICKET_SECRET: 's'.repeat(32),
    }),
    { db },
  );
  afterAll(async () => {
    await app.close();
    await close();
  });

  it('returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
