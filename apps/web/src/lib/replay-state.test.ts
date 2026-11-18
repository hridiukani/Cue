import { randomUUID } from 'node:crypto';
import { CLOSE_CODE, type ServerMessage } from '@cue/shared';
import { describe, expect, it } from 'vitest';
import {
  initialReplayState,
  MAX_RECONNECT_ATTEMPTS,
  reconnectDelayMs,
  type ReplayAction,
  replayReducer,
  type ReplayState,
  shouldReconnect,
} from './replay-state';

let seq = 0;
const env = () => ({ seq: seq++, serverTs: 1 });
const server = (message: Record<string, unknown>): ReplayAction => ({
  type: 'server',
  message: { ...message, ...env() } as unknown as ServerMessage,
});
const run = (actions: ReplayAction[], from: ReplayState = initialReplayState(60_000)) =>
  actions.reduce(replayReducer, from);

const SESSION = randomUUID();
const session = (id = SESSION) =>
  server({
    type: 'session',
    sessionId: id,
    recordingId: randomUUID(),
    title: 'Call',
    durationMs: 90_000,
    timing: 'real',
    capabilities: { seek: true, speeds: ['1x', '2x', 'instant'] },
  });
const final = (id: string, key: string, startMs: number, text = key) =>
  server({
    type: 'final',
    utteranceId: id,
    speaker: 'rep',
    key,
    text,
    startMs,
    endMs: startMs + 500,
  });
const interim = (key: string, text: string) =>
  server({ type: 'interim', speaker: 'prospect', key, text, startMs: 0, endMs: 100 });

describe('replayReducer', () => {
  it('goes connecting → open on ready, and adopts the session', () => {
    const s = run([server({ type: 'ready', v: 1 }), session()]);
    expect(s).toMatchObject({ connection: 'open', sessionId: SESSION, durationMs: 90_000 });
  });

  it('shows interims, then replaces each with its final', () => {
    const s1 = run([session(), interim('u-0', 'hello'), interim('u-0', 'hello there')]);
    expect(s1.interims['u-0']?.text).toBe('hello there');
    const s2 = run([final('a', 'u-0', 0, 'hello there friend')], s1);
    expect(s2.interims).toEqual({});
    expect(s2.finals.map((f) => f.text)).toEqual(['hello there friend']);
  });

  it('keeps finals in timeline order and never duplicates one', () => {
    const s = run([
      session(),
      final('b', 'u-1', 2000),
      final('a', 'u-0', 0),
      final('b', 'u-1', 2000),
    ]);
    expect(s.finals.map((f) => f.key)).toEqual(['u-0', 'u-1']);
  });

  it('a new session (backward seek) starts a fresh transcript', () => {
    const s = run([session(), final('a', 'u-0', 0), session(randomUUID())]);
    expect(s.finals).toEqual([]);
  });

  it('a snapshot (resume) replaces the transcript with what was saved', () => {
    const s = run([
      session(),
      final('x', 'stale', 0),
      server({
        type: 'snapshot',
        utterances: [
          {
            utteranceId: 'b',
            speaker: 'prospect',
            key: 'saved-b',
            text: 'two',
            startMs: 900,
            endMs: 1000,
          },
          { utteranceId: 'a', speaker: 'rep', key: 'saved-a', text: 'one', startMs: 0, endMs: 100 },
        ],
      }),
    ]);
    expect(s.finals.map((f) => f.text)).toEqual(['one', 'two']);
  });

  it('tracks playback state, position and speed; pausing clears interims', () => {
    const s = run([
      session(),
      interim('u-0', 'hi'),
      server({ type: 'state', state: 'paused', positionMs: 1234, speed: '2x' }),
    ]);
    expect(s).toMatchObject({ playback: 'paused', positionMs: 1234, speed: '2x', interims: {} });
  });

  it('shows a reconnecting banner with the attempt number, and clears it when back', () => {
    const open = run([
      server({ type: 'ready', v: 1 }),
      session(),
      final('a', 'u-0', 0),
      interim('u-1', 'x'),
    ]);
    const dropped = run([{ type: 'socket_closed', code: 1006, attempt: 2, willRetry: true }], open);
    expect(dropped).toMatchObject({ connection: 'reconnecting', attempt: 2, interims: {} });
    expect(dropped.banner?.message).toContain('attempt 2');
    expect(dropped.finals).toHaveLength(1); // finals survive a drop
    const back = run([server({ type: 'ready', v: 1 })], dropped);
    expect(back).toMatchObject({ connection: 'open', banner: null });
  });

  it('says the server is restarting on 1001', () => {
    const s = run([
      { type: 'socket_closed', code: CLOSE_CODE.serverShutdown, attempt: 1, willRetry: true },
    ]);
    expect(s.banner?.message).toMatch(/server is restarting/);
  });

  it('offers a reconnect button after giving up, and a restart when the session is gone', () => {
    expect(run([{ type: 'gave_up' }]).banner).toMatchObject({
      level: 'error',
      action: 'reconnect',
    });
    const gone = run([
      { type: 'socket_closed', code: CLOSE_CODE.notFound, attempt: 1, willRetry: false },
    ]);
    expect(gone).toMatchObject({ connection: 'not_found', banner: { action: 'restart' } });
  });

  it('turns a save failure into a Retry banner and source failure into Restart', () => {
    const saveFail = run([
      server({
        type: 'status',
        level: 'error',
        code: 'persist_failed',
        message: 'Could not save',
        retryable: true,
      }),
    ]);
    expect(saveFail.banner).toEqual({ level: 'error', message: 'Could not save', action: 'retry' });
    const failed = run([server({ type: 'state', state: 'failed', positionMs: 0, speed: '1x' })]);
    expect(failed.banner?.action).toBe('restart');
  });
});

describe('reconnect policy', () => {
  it('backs off 0.5 s, 1 s, 2 s … capped at 10 s, with 50–100 % jitter', () => {
    const max = () => 1; // no jitter reduction
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((a) => reconnectDelayMs(a, max))).toEqual([
      500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000,
    ]);
    expect(reconnectDelayMs(3, () => 0)).toBe(1000);
    expect(MAX_RECONNECT_ATTEMPTS).toBe(8);
  });

  it('retries drops, restarts and bad tickets, but not a deliberate close or a missing session', () => {
    expect(shouldReconnect(1006)).toBe(true);
    expect(shouldReconnect(CLOSE_CODE.serverShutdown)).toBe(true);
    expect(shouldReconnect(CLOSE_CODE.unauthorized)).toBe(true);
    expect(shouldReconnect(1000)).toBe(false);
    expect(shouldReconnect(CLOSE_CODE.notFound)).toBe(false);
  });
});
