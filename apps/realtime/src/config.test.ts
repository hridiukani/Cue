import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const REQUIRED = {
  DATABASE_URL: 'postgres://cue:cue@localhost:5434/cue',
  REALTIME_TICKET_SECRET: 's'.repeat(32),
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(REQUIRED)).toEqual({
      nodeEnv: 'development',
      host: 'localhost',
      port: 4000,
      logLevel: 'info',
      databaseUrl: REQUIRED.DATABASE_URL,
      ticketSecret: REQUIRED.REALTIME_TICKET_SECRET,
      allowedOrigins: ['http://localhost:3000'],
      groq: {
        apiKey: undefined,
        model: 'llama-3.1-8b-instant',
        baseUrl: 'https://api.groq.com/openai/v1',
      },
      suggestions: { firstTokenTimeoutMs: 1500, totalTimeoutMs: 5000 },
    });
  });

  it('reads Groq settings and treats an empty key as unset', () => {
    expect(loadConfig({ ...REQUIRED, GROQ_API_KEY: '' }).groq.apiKey).toBeUndefined();
    expect(
      loadConfig({ ...REQUIRED, GROQ_API_KEY: 'gsk_x', GROQ_MODEL: 'openai/gpt-oss-20b' }).groq,
    ).toMatchObject({ apiKey: 'gsk_x', model: 'openai/gpt-oss-20b' });
    expect(() => loadConfig({ ...REQUIRED, SUGGESTION_FIRST_TOKEN_TIMEOUT_MS: '5' })).toThrow(
      /SUGGESTION_FIRST_TOKEN_TIMEOUT_MS/,
    );
  });

  it('coerces REALTIME_PORT from a string', () => {
    expect(loadConfig({ ...REQUIRED, REALTIME_PORT: '4100' }).port).toBe(4100);
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ ...REQUIRED, REALTIME_PORT: '99999' })).toThrow(/REALTIME_PORT/);
  });

  it('rejects an unknown log level', () => {
    expect(() => loadConfig({ ...REQUIRED, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  it('requires the database URL and a long enough ticket secret', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*REALTIME_TICKET_SECRET/);
    expect(() => loadConfig({ ...REQUIRED, REALTIME_TICKET_SECRET: 'short' })).toThrow(
      /at least 32/,
    );
  });

  it('parses a comma-separated origin allowlist', () => {
    expect(
      loadConfig({
        ...REQUIRED,
        REALTIME_ALLOWED_ORIGINS: 'http://localhost:3000, https://cue.example.com',
      }).allowedOrigins,
    ).toEqual(['http://localhost:3000', 'https://cue.example.com']);
  });
});
