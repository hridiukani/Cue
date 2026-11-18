import { beforeEach, describe, expect, it } from 'vitest';
import {
  AudioSync,
  JUMP_MS,
  type MediaLike,
  RESYNC_AFTER_MS,
  SYNC_TOLERANCE_MS,
  type Timeline,
} from './audio-sync';

/** Fake time: only moves when the test says so. */
class FakeClock {
  t = 1_000_000;
  now() {
    return this.t;
  }
}

/**
 * A media element whose playhead advances with the fake clock while playing,
 * unless it's stalled (buffering). `skew` makes its clock run fast or slow.
 */
class FakeMedia implements MediaLike {
  private posMs = 0;
  private since: number;
  private rate = 1;
  paused = true;
  seeking = false;
  stalled = false;
  skew = 1;
  duration = 600; // seconds
  error: unknown = null;
  playRejection: Error | null = null;
  readonly seeks: number[] = [];
  playCalls = 0;

  constructor(private readonly clock: FakeClock) {
    this.since = clock.now();
  }
  private settle() {
    const now = this.clock.now();
    if (!this.paused && !this.stalled) this.posMs += (now - this.since) * this.rate * this.skew;
    this.since = now;
  }
  get readyState() {
    return this.stalled ? 2 : 4;
  }
  get currentTime() {
    this.settle();
    return this.posMs / 1000;
  }
  set currentTime(s: number) {
    this.settle();
    this.posMs = s * 1000;
    this.seeks.push(s);
  }
  get playbackRate() {
    return this.rate;
  }
  set playbackRate(r: number) {
    this.settle();
    this.rate = r;
  }
  setStalled(stalled: boolean) {
    this.settle();
    this.stalled = stalled;
  }
  play() {
    this.playCalls++;
    if (this.playRejection) return Promise.reject(this.playRejection);
    this.settle();
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.settle();
    this.paused = true;
  }
}

let clock: FakeClock;
let media: FakeMedia;
let sync: AudioSync;
/** The server's transcript timeline, as its `state` messages would report it. */
let server: Timeline;

const TRANSCRIPT_MS = 600_000;

beforeEach(() => {
  clock = new FakeClock();
  media = new FakeMedia(clock);
  sync = new AudioSync(media, clock, { transcriptDurationMs: TRANSCRIPT_MS });
  server = { playback: 'idle', positionMs: 0, speed: '1x' };
});

const flush = () => new Promise((r) => setImmediate(r));

/** The server changes state (play, pause, seek, speed) and tells the browser. */
function serverSays(t: Partial<Timeline>) {
  server = { ...server, ...t };
  sync.setTimeline(server);
}

/**
 * Let `ms` pass: the server's timeline advances at its speed and sends a
 * position update every timeline second; the page ticks the sync every 250 ms.
 */
function run(ms: number, step = 250) {
  let last = sync.tick();
  let sinceState = 0;
  const factor = server.speed === '2x' ? 2 : 1;
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    clock.t += step;
    if (server.playback === 'playing') {
      server = {
        ...server,
        positionMs: Math.min(TRANSCRIPT_MS, server.positionMs + step * factor),
      };
      sinceState += step * factor;
      if (sinceState >= 1000) {
        sinceState = 0;
        sync.setTimeline(server);
      }
    }
    last = sync.tick();
  }
  return last;
}

describe('AudioSync', () => {
  it('does nothing before a replay starts', () => {
    expect(sync.tick()).toMatchObject({ status: 'idle', driftMs: null });
    expect(media.playCalls).toBe(0);
  });

  it('plays the audio with the transcript at 1x and stays in sync', async () => {
    serverSays({ playback: 'playing', positionMs: 0 });
    await flush();
    expect(media.paused).toBe(false);
    expect(media.playbackRate).toBe(1);
    const s = run(10_000);
    expect(s).toMatchObject({ status: 'in_sync', driftMs: 0, resyncs: 0 });
    expect(s.transcriptMs).toBe(10_000);
    expect(media.currentTime).toBe(10);
  });

  it('plays at double rate at 2x, on the same timeline', () => {
    serverSays({ playback: 'playing', positionMs: 0, speed: '2x' });
    expect(media.playbackRate).toBe(2);
    const s = run(3000);
    expect(s).toMatchObject({ status: 'in_sync', driftMs: 0, transcriptMs: 6000 });
    expect(media.currentTime).toBe(6);
  });

  it('switching speed mid-replay changes the audio rate without a jump', () => {
    serverSays({ playback: 'playing', positionMs: 0 });
    run(2000);
    serverSays({ speed: '2x' });
    expect(media.playbackRate).toBe(2);
    expect(run(2000)).toMatchObject({ status: 'in_sync', driftMs: 0, transcriptMs: 6000 });
    expect(media.seeks).toEqual([]);
  });

  it('pause stops the audio and parks it on the transcript position', () => {
    serverSays({ playback: 'playing', positionMs: 0 });
    run(4000);
    serverSays({ playback: 'paused', positionMs: 4000 });
    expect(media.paused).toBe(true);
    const s = run(5000);
    expect(s).toMatchObject({ status: 'paused', driftMs: 0, transcriptMs: 4000 });
    expect(media.currentTime).toBe(4);
  });

  it('a seek moves the audio at once and is not counted as drift', () => {
    serverSays({ playback: 'playing', positionMs: 0 });
    run(2000);
    serverSays({ positionMs: 90_000 }); // the user seeked
    expect(media.currentTime).toBe(90);
    expect(run(2000)).toMatchObject({ status: 'in_sync', resyncs: 0, transcriptMs: 92_000 });
  });

  it('a seek while paused moves the parked audio too', () => {
    serverSays({ playback: 'paused', positionMs: 0 });
    serverSays({ positionMs: 30_000 });
    expect(media.currentTime).toBe(30);
    expect(media.paused).toBe(true);
  });

  it('a new session at an earlier position (backward seek) moves the audio back', () => {
    serverSays({ playback: 'playing', positionMs: 0 });
    run(60_000);
    serverSays({ playback: 'playing', positionMs: 10_000 });
    expect(media.currentTime).toBe(10);
    expect(run(1000).resyncs).toBe(0);
  });

  it('tolerates drift up to the tolerance without touching the audio', () => {
    serverSays({ playback: 'playing', positionMs: 0 });
    media.skew = 1.015; // audio clock runs 1.5 % fast: 150 ms over 10 s
    const s = run(10_000);
    expect(s.status).toBe('in_sync');
    expect(s.driftMs).toBeGreaterThan(100);
    expect(s.driftMs).toBeLessThanOrEqual(SYNC_TOLERANCE_MS);
    expect(media.seeks).toEqual([]);
  });

  it('reports drift past the tolerance, then resyncs once it lasts, and counts it', () => {
    serverSays({ playback: 'playing', positionMs: 0 });
    media.skew = 1.05; // 50 ms ahead per second
    const seen: string[] = [];
    let s = sync.tick();
    for (let i = 0; i < 40 && s.resyncs === 0; i++) {
      s = run(250);
      seen.push(s.status);
    }
    // It was shown as drifting (with a number) before anything was corrected.
    expect(seen.filter((x) => x === 'drifting').length).toBeGreaterThanOrEqual(
      RESYNC_AFTER_MS / 250,
    );
    expect(s.resyncs).toBe(1);
    expect(s.lastResync?.driftMs).toBeGreaterThan(SYNC_TOLERANCE_MS);
    expect(media.seeks).toHaveLength(1);
    media.skew = 1;
    expect(run(1000)).toMatchObject({ status: 'in_sync', resyncs: 1 });
  });

  it('does not resync a short spike that settles within the window', () => {
    serverSays({ playback: 'playing', positionMs: 0 });
    run(1000);
    media.currentTime += 0.4; // something nudged the audio 400 ms ahead
    expect(run(250)).toMatchObject({ status: 'drifting' });
    expect(sync.tick().driftMs).toBe(400);
    media.currentTime -= 0.4; // and it came back
    expect(run(2000)).toMatchObject({ status: 'in_sync', resyncs: 0 });
  });

  it('shows buffering while the transcript keeps going, then catches the audio up', () => {
    serverSays({ playback: 'playing', positionMs: 0 });
    run(2000);
    media.setStalled(true);
    const during = run(3000);
    // The transcript (and the suggestions) never waited for the audio.
    expect(during).toMatchObject({ status: 'buffering', transcriptMs: 5000, audioMs: 2000 });
    expect(during.driftMs).toBe(-3000);
    expect(media.seeks).toEqual([]); // no seeking while it's still loading

    media.setStalled(false);
    const after = run(250);
    expect(after.resyncs).toBe(1);
    // Caught up on the first tick after buffering ended (it had been out for > 1 s).
    expect(after.lastResync).toEqual({ driftMs: -3000, atMs: 5000 });
    expect(run(1000)).toMatchObject({ status: 'in_sync', resyncs: 1 });
  });

  it('turns the audio off at instant speed and resumes it in place at 1x', async () => {
    serverSays({ playback: 'playing', positionMs: 0 });
    run(2000);
    serverSays({ speed: 'instant' });
    expect(media.paused).toBe(true);
    expect(sync.tick()).toMatchObject({ status: 'off_at_instant', driftMs: null });
    serverSays({ speed: '1x', positionMs: 120_000 });
    await flush();
    expect(media.paused).toBe(false);
    expect(media.currentTime).toBe(120);
    expect(run(1000).status).toBe('in_sync');
  });

  it('says so when the browser blocks playback, and plays after a click', async () => {
    const blocked = new Error('autoplay');
    blocked.name = 'NotAllowedError';
    media.playRejection = blocked;
    serverSays({ playback: 'playing', positionMs: 0 });
    await flush();
    expect(run(1000).status).toBe('blocked');
    const calls = media.playCalls;
    run(2000);
    expect(media.playCalls).toBe(calls); // doesn't hammer play() while blocked

    media.playRejection = null;
    sync.unblock();
    await flush();
    expect(media.paused).toBe(false);
    const s = run(1500); // it was behind; it gets caught up and counted
    expect(s.resyncs).toBe(1);
  });

  it('ignores an AbortError from play() (a pause interrupted it)', async () => {
    const aborted = new Error('interrupted');
    aborted.name = 'AbortError';
    media.playRejection = aborted;
    serverSays({ playback: 'playing', positionMs: 0 });
    await flush();
    expect(sync.tick().status).not.toBe('blocked');
  });

  it('reports a failed audio load without affecting the timeline', () => {
    serverSays({ playback: 'playing', positionMs: 0 });
    media.error = { code: 4 };
    const s = run(3000);
    expect(s).toMatchObject({ status: 'error', driftMs: null, transcriptMs: 3000 });
  });

  it('says when the transcript runs past the end of the audio', () => {
    media.duration = 5;
    serverSays({ playback: 'playing', positionMs: 0 });
    expect(run(6000)).toMatchObject({ status: 'audio_ended', driftMs: null });
    expect(media.paused).toBe(true);
  });

  it('stops the audio when the replay ends or fails', () => {
    serverSays({ playback: 'playing', positionMs: 0 });
    run(1000);
    serverSays({ playback: 'ended', positionMs: 1000 });
    expect(media.paused).toBe(true);
  });

  it('extrapolates between server updates and clamps to the transcript length', () => {
    serverSays({ playback: 'playing', positionMs: TRANSCRIPT_MS - 500 });
    clock.t += 400;
    expect(sync.transcriptMs()).toBe(TRANSCRIPT_MS - 100);
    clock.t += 5000;
    expect(sync.transcriptMs()).toBe(TRANSCRIPT_MS);
  });

  it('treats small re-anchoring differences as drift, not seeks', () => {
    serverSays({ playback: 'playing', positionMs: 0 });
    clock.t += 1000;
    serverSays({ positionMs: 1000 + JUMP_MS - 100 }); // a late update, not a seek
    expect(media.seeks).toEqual([]);
  });
});
