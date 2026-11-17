import { describe, expect, it } from 'vitest';
import { parsePublicConfig } from './config';

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
