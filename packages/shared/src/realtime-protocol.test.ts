import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_CLIENT_MESSAGE_BYTES,
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
} from './realtime-protocol';

const json = (v: unknown) => JSON.stringify(v);

describe('parseClientMessage', () => {
  it('accepts every client message type', () => {
    const msgs = [
      { type: 'hello', v: PROTOCOL_VERSION, ticket: 'v1.a.b' },
      { type: 'start', recordingId: randomUUID(), speed: '1x' },
      { type: 'start', recordingId: randomUUID(), speed: 'instant', positionMs: 5000 },
      { type: 'resume', sessionId: randomUUID() },
      { type: 'play' },
      { type: 'pause' },
      { type: 'seek', positionMs: 0 },
      { type: 'setSpeed', speed: '2x' },
      { type: 'ping' },
    ];
    for (const m of msgs) expect(parseClientMessage(json(m))).toEqual({ ok: true, message: m });
  });

  it.each([
    ['unknown type', { type: 'shutdown' }],
    ['extra field', { type: 'play', userId: 'x' }],
    ['wrong protocol version', { type: 'hello', v: 2, ticket: 't' }],
    ['bad speed', { type: 'setSpeed', speed: '10x' }],
    ['negative position', { type: 'seek', positionMs: -1 }],
    ['non-uuid id', { type: 'resume', sessionId: 'abc' }],
  ])('rejects %s', (_label, msg) => {
    expect(parseClientMessage(json(msg)).ok).toBe(false);
  });

  it('rejects invalid JSON and oversized frames before parsing', () => {
    expect(parseClientMessage('{nope')).toEqual({ ok: false, error: 'not valid JSON' });
    const big = json({ type: 'hello', v: 1, ticket: 'x'.repeat(MAX_CLIENT_MESSAGE_BYTES) });
    expect(parseClientMessage(big)).toEqual({ ok: false, error: 'message too large' });
  });
});

describe('parseServerMessage', () => {
  const env = { seq: 3, serverTs: 1_790_000_000_000 };

  it('accepts a final and a session message', () => {
    const final = {
      type: 'final',
      utteranceId: randomUUID(),
      speaker: 'prospect',
      key: 'u-1',
      text: 'Hello?',
      startMs: 0,
      endMs: 900,
      ...env,
    };
    expect(parseServerMessage(json(final)).ok).toBe(true);
    const session = {
      type: 'session',
      sessionId: randomUUID(),
      recordingId: randomUUID(),
      title: 'Call',
      durationMs: 60000,
      timing: 'estimated',
      capabilities: { seek: true, speeds: ['1x', '2x', 'instant'] },
      ...env,
    };
    expect(parseServerMessage(json(session)).ok).toBe(true);
  });

  it('requires the envelope on every server message', () => {
    expect(parseServerMessage(json({ type: 'pong' })).ok).toBe(false);
  });
});
