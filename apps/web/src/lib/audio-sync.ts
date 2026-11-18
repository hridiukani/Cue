import type { SessionState, Speed } from '@cue/shared';

/**
 * Keeps an <audio> element on the replay's ONE timeline: the transcript
 * timeline the realtime server plays (and the suggestion engine reacts to).
 *
 * - The server is the clock. Its `state` messages (position, playing/paused,
 *   speed) anchor the timeline; between them the position is extrapolated at
 *   the replay speed. The audio follows; it never drives the server, so
 *   buffering audio can't stall the transcript or the suggestions.
 * - Drift = audio position - transcript position (+ means audio is ahead).
 *   It's measured on every tick and always reported, never hidden:
 *   - within SYNC_TOLERANCE_MS: in sync;
 *   - beyond it: "drifting", shown with the number. If it stays beyond it
 *     for RESYNC_AFTER_MS, the audio is moved back onto the timeline and the
 *     correction is counted (and shown) as a resync.
 * - A timeline change bigger than JUMP_MS (a seek, a new session) moves the
 *   audio at once. That's following the user, not drift, so it isn't counted.
 * - At instant speed there's no audio (it can't play that fast).
 *
 * Pure apart from the media element and clock passed in, so tests drive it
 * with a fake media element on fake time.
 */

export const SYNC_TOLERANCE_MS = 200;
export const RESYNC_AFTER_MS = 1000;
export const JUMP_MS = 1500;
/** After moving the audio, give it this long to settle before judging again. */
export const RESYNC_GRACE_MS = 500;
/** HTMLMediaElement.HAVE_FUTURE_DATA: enough buffered to keep playing. */
const HAVE_FUTURE_DATA = 3;

const RATE: Record<Speed, number | null> = { '1x': 1, '2x': 2, instant: null };

/** The parts of HTMLMediaElement this uses (times in seconds, like the DOM). */
export interface MediaLike {
  currentTime: number;
  playbackRate: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly readyState: number;
  /** NaN until the browser knows it. */
  readonly duration: number;
  readonly error: unknown;
  play(): Promise<void>;
  pause(): void;
}

export interface SyncClock {
  /** Milliseconds, monotonic (performance.now() in the browser). */
  now(): number;
}

export interface Timeline {
  playback: SessionState | 'idle';
  positionMs: number;
  speed: Speed;
}

export type AudioSyncStatus =
  | 'idle' // no replay running yet
  | 'in_sync'
  | 'drifting' // beyond tolerance: shown with the drift
  | 'buffering' // timeline playing, audio waiting for data
  | 'paused'
  | 'off_at_instant'
  | 'blocked' // the browser refused to start audio; needs a click
  | 'audio_ended' // the transcript runs past the end of the audio
  | 'error'; // the audio failed to load; the transcript carries on

export interface AudioSyncSnapshot {
  status: AudioSyncStatus;
  /** Audio minus transcript position, ms (+ = audio ahead). null when not comparable. */
  driftMs: number | null;
  transcriptMs: number;
  audioMs: number;
  /** Times the audio was moved back onto the timeline because of drift. */
  resyncs: number;
  lastResync: { driftMs: number; atMs: number } | null;
}

interface Anchor {
  positionMs: number;
  at: number;
  playing: boolean;
  rate: number;
}

export class AudioSync {
  private anchor: Anchor | null = null;
  private timeline: Timeline = { playback: 'idle', positionMs: 0, speed: '1x' };
  private outOfToleranceSince: number | null = null;
  private graceUntil = 0;
  private blocked = false;
  private resyncs = 0;
  private lastResync: AudioSyncSnapshot['lastResync'] = null;

  constructor(
    private readonly media: MediaLike,
    private readonly clock: SyncClock,
    private readonly opts: { transcriptDurationMs: number },
  ) {}

  /** Where the transcript timeline is now, extrapolated from the last server state. */
  transcriptMs(now = this.clock.now()): number {
    const a = this.anchor;
    if (!a) return 0;
    const ms = a.playing ? a.positionMs + (now - a.at) * a.rate : a.positionMs;
    return Math.min(Math.max(0, ms), this.opts.transcriptDurationMs);
  }

  /** A server `state` arrived (or the session changed): re-anchor and follow it. */
  setTimeline(t: Timeline): void {
    const now = this.clock.now();
    const before = this.anchor ? this.transcriptMs(now) : null;
    const rate = RATE[t.speed];
    const playing = t.playback === 'playing' && rate !== null;
    this.timeline = t;
    this.anchor = { positionMs: t.positionMs, at: now, playing, rate: rate ?? 1 };

    const jumped = before === null || Math.abs(t.positionMs - before) > JUMP_MS;
    if (jumped) this.outOfToleranceSince = null;

    if (!playing) {
      if (!this.media.paused) this.media.pause();
      // Paused (or seeked while paused): park the audio on the position.
      if (rate !== null && t.playback !== 'idle') this.moveAudio(t.positionMs, now);
      return;
    }
    if (this.media.playbackRate !== rate) this.media.playbackRate = rate;
    if (jumped) this.moveAudio(t.positionMs, now);
    this.ensurePlaying();
  }

  /** The user clicked to allow audio after the browser blocked autoplay. */
  unblock(): void {
    this.blocked = false;
    if (this.anchor?.playing) this.ensurePlaying();
  }

  /** Measure drift and correct it if it has lasted too long. Call often (e.g. every 250 ms). */
  tick(): AudioSyncSnapshot {
    const now = this.clock.now();
    const transcriptMs = this.transcriptMs(now);
    const audioMs = this.media.currentTime * 1000;
    const snap = (status: AudioSyncStatus, driftMs: number | null): AudioSyncSnapshot => ({
      status,
      driftMs: driftMs === null ? null : Math.round(driftMs),
      transcriptMs: Math.round(transcriptMs),
      audioMs: Math.round(audioMs),
      resyncs: this.resyncs,
      lastResync: this.lastResync,
    });

    const t = this.timeline;
    if (!this.anchor || t.playback === 'idle') return snap('idle', null);
    if (this.media.error) return snap('error', null);
    if (t.speed === 'instant') return snap('off_at_instant', null);
    if (this.blocked) return snap('blocked', audioMs - transcriptMs);

    const audioEndMs = Number.isFinite(this.media.duration) ? this.media.duration * 1000 : null;
    if (audioEndMs !== null && transcriptMs >= audioEndMs) {
      if (!this.media.paused) this.media.pause();
      return snap('audio_ended', null);
    }

    const drift = audioMs - transcriptMs;
    if (!this.anchor.playing) return snap('paused', drift);

    if (this.media.paused) this.ensurePlaying(); // something else paused it
    const buffering = this.media.seeking || this.media.readyState < HAVE_FUTURE_DATA;
    if (Math.abs(drift) <= SYNC_TOLERANCE_MS) {
      this.outOfToleranceSince = null;
      return snap(buffering ? 'buffering' : 'in_sync', drift);
    }

    this.outOfToleranceSince ??= now;
    // Moving the audio while it's still loading would only restart the wait.
    if (buffering) return snap('buffering', drift);
    const lasted = now - this.outOfToleranceSince >= RESYNC_AFTER_MS;
    if (lasted && now >= this.graceUntil) {
      this.resyncs += 1;
      this.lastResync = { driftMs: Math.round(drift), atMs: Math.round(transcriptMs) };
      this.outOfToleranceSince = null;
      this.moveAudio(transcriptMs, now);
    }
    return snap('drifting', drift);
  }

  private moveAudio(positionMs: number, now: number): void {
    const target = positionMs / 1000;
    if (Math.abs(this.media.currentTime - target) * 1000 <= SYNC_TOLERANCE_MS / 4) return;
    this.media.currentTime = target;
    this.graceUntil = now + RESYNC_GRACE_MS;
  }

  private ensurePlaying(): void {
    if (this.blocked || !this.media.paused) return;
    this.media.play().catch((err: unknown) => {
      // NotAllowedError: autoplay policy. (AbortError just means a pause interrupted it.)
      if (err instanceof Error && err.name === 'NotAllowedError') this.blocked = true;
    });
  }
}
