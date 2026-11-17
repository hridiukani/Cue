import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { buildServer } from './server';

describe('GET /health', () => {
  const app = buildServer(
    loadConfig({
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgres://cue:cue@localhost:5434/cue',
      REALTIME_TICKET_SECRET: 's'.repeat(32),
    }),
  );
  afterAll(() => app.close());

  it('returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
