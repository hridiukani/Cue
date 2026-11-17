import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({})).toEqual({
      nodeEnv: 'development',
      host: 'localhost',
      port: 4000,
      logLevel: 'info',
    });
  });

  it('coerces REALTIME_PORT from a string', () => {
    expect(loadConfig({ REALTIME_PORT: '4100' }).port).toBe(4100);
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ REALTIME_PORT: '99999' })).toThrow(/REALTIME_PORT/);
  });

  it('rejects an unknown log level', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });
});
