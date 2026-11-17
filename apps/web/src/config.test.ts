import { describe, expect, it } from 'vitest';
import { parsePublicConfig, parseServerConfig } from './config';

describe('parseServerConfig', () => {
  const env = {
    DATABASE_URL: 'postgres://cue:cue@localhost:5434/cue',
    AUTH_SECRET: 'x'.repeat(32),
    AUTH_GITHUB_ID: 'gh-id',
    AUTH_GITHUB_SECRET: 'gh-secret',
  };

  it('maps env vars to config', () => {
    expect(parseServerConfig(env)).toEqual({
      databaseUrl: env.DATABASE_URL,
      authSecret: env.AUTH_SECRET,
      githubClientId: 'gh-id',
      githubClientSecret: 'gh-secret',
    });
  });

  it('rejects a short AUTH_SECRET', () => {
    expect(() => parseServerConfig({ ...env, AUTH_SECRET: 'short' })).toThrow(/AUTH_SECRET/);
  });

  it('names every missing variable', () => {
    expect(() => parseServerConfig({})).toThrow(
      /DATABASE_URL[\s\S]*AUTH_SECRET[\s\S]*AUTH_GITHUB_ID/,
    );
  });
});

describe('parsePublicConfig', () => {
  it('defaults the realtime URL for local dev', () => {
    expect(parsePublicConfig({})).toEqual({ realtimeUrl: 'ws://localhost:4000' });
  });

  it('accepts wss:// URLs', () => {
    expect(
      parsePublicConfig({ NEXT_PUBLIC_REALTIME_URL: 'wss://rt.example.com' }).realtimeUrl,
    ).toBe('wss://rt.example.com');
  });

  it('rejects non-websocket URLs', () => {
    expect(() => parsePublicConfig({ NEXT_PUBLIC_REALTIME_URL: 'http://localhost:4000' })).toThrow(
      /ws:\/\//,
    );
  });
});
