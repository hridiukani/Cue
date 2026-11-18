import type { Speaker, Speed } from '@cue/shared';
import type { Clock, TimerHandle } from '../clock';
import type { CallSource, CallSourceCapabilities, SourceEvent } from './call-source';

export interface TimedUtterance {
  idx: number;
  speaker: Speaker;
  text: string;
  startedMs: number;
  endedMs: number;
}

type TimelineEvent =
  | { at: number; kind: 'interim'; u: TimedUtterance; words: number }
  | { at: number; kind: 'final'; u: TimedUtterance }
  | { at: number; kind: 'tick' };

const SPEED_FACTOR: Record<Speed, number> = { '1x': 1, '2x': 2, instant: Infinity };
/** How often, in timeline ms, a growing interim is emitted while someone speaks. */
const INTERIM_STEP_MS = 300;
/** How often the position is reported during silence (for the seek bar). */
const TICK_MS = 1000;

/**
 * Replays a timed transcript as if it were live: for each utterance, interim
 * results with progressively more words while it's "being spoken", then a
 * final at its end time. Everything is scheduled on a Clock and scaled by
 * speed. `instant` emits finals only, one per clock turn, so the consumer
 * (socket, database) can keep up.
 */
export class TranscriptSource implements CallSource {
  readonly kind = 'transcript' as const;
  readonly capabilities: CallSourceCapabilities = { seek: true, speeds: ['1x', '2x', 'instant'] };
  readonly durationMs: number;

  private readonly events: TimelineEvent[];
  private readonly listeners = new Set<(e: SourceEvent) => void>();
  private cursor = 0; // index of the next event to emit
  /** Timeline position at clock time `positionAt`; while playing it keeps advancing from there. */
  private position = 0;
  private positionAt = 0;
  private currentSpeed: Speed = '1x';
  private isPlaying = false;
  private closed = false;
  private timer: TimerHandle | null = null;
  // Bumped on every seek/pause/speed change; a timer from an older generation does nothing.
  private generation = 0;

  constructor(
    utterances: readonly TimedUtterance[],
    private readonly clock: Clock,
  ) {
    const sorted = [...utterances].sort((a, b) => a.startedMs - b.startedMs || a.idx - b.idx);
    this.durationMs = sorted.reduce((max, u) => Math.max(max, u.endedMs), 0);
    this.events = buildTimeline(sorted, this.durationMs);
  }

  /**
   * Where the timeline is now: the last event's time plus the time played
   * since, at the current speed (never past the next event, which hasn't fired).
   */
  get positionMs(): number {
    if (!this.isPlaying || this.currentSpeed === 'instant' || this.timer === null) {
      return this.position;
    }
    const elapsed = (this.clock.now() - this.positionAt) * SPEED_FACTOR[this.currentSpeed];
    const next = this.events[this.cursor]?.at ?? this.durationMs;
    return Math.min(this.position + Math.max(0, elapsed), next);
  }

  /**
   * Fold the time played since the last event into `position`. Call before
   * anything that reschedules (pause, speed change): otherwise that time is
   * lost and the transcript falls further behind the recording on every change.
   */
  private settlePosition(): void {
    this.position = this.positionMs;
    this.positionAt = this.clock.now();
  }
  get speed(): Speed {
    return this.currentSpeed;
  }
  get playing(): boolean {
    return this.isPlaying;
  }

  on(listener: (e: SourceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(fromMs: number, speed: Speed): void {
    this.currentSpeed = speed;
    this.jumpTo(fromMs);
    this.isPlaying = true;
    this.scheduleNext();
  }

  pause(): void {
    this.settlePosition();
    this.isPlaying = false;
    this.cancelTimer();
  }

  resume(): void {
    if (this.closed || this.isPlaying) return;
    this.isPlaying = true;
    this.positionAt = this.clock.now(); // paused time doesn't count
    this.scheduleNext();
  }

  seek(toMs: number): void {
    this.cancelTimer();
    this.jumpTo(toMs);
    this.emit({ type: 'position', positionMs: this.position });
    if (this.isPlaying) this.scheduleNext();
  }

  setSpeed(speed: Speed): void {
    this.settlePosition(); // measured at the old speed
    this.currentSpeed = speed;
    this.cancelTimer();
    if (this.isPlaying) this.scheduleNext();
  }

  close(): Promise<void> {
    this.closed = true;
    this.pause();
    this.listeners.clear();
    return Promise.resolve();
  }

  /** Position at `ms`; events at or after it will be emitted (inclusive, so nothing is lost). */
  private jumpTo(ms: number): void {
    const target = Math.max(0, Math.min(ms, this.durationMs));
    this.position = target;
    this.positionAt = this.clock.now();
    this.cursor = this.events.findIndex((e) => e.at >= target);
    if (this.cursor === -1) this.cursor = this.events.length;
  }

  private cancelTimer(): void {
    this.generation++;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(): void {
    if (!this.isPlaying || this.closed) return;
    const instant = this.currentSpeed === 'instant';
    // Instant skips interims and ticks: only finals matter.
    while (
      instant &&
      this.cursor < this.events.length &&
      this.events[this.cursor]?.kind !== 'final'
    ) {
      this.cursor++;
    }
    const next = this.events[this.cursor];
    if (!next) {
      this.isPlaying = false;
      this.position = this.durationMs;
      this.emit({ type: 'position', positionMs: this.position });
      this.emit({ type: 'ended' });
      return;
    }
    // Due relative to when the previous event was DUE, not when its timer
    // actually ran: timers fire a few ms late, and chaining from the real fire
    // time would add that lateness up (about 0.8 s per 17 s at 2x, measured).
    const now = this.clock.now();
    const dueAt = instant
      ? now
      : this.positionAt + (next.at - this.position) / SPEED_FACTOR[this.currentSpeed];
    const generation = this.generation;
    this.timer = this.clock.setTimeout(
      () => {
        if (generation !== this.generation) return; // stale: a seek/pause happened
        this.timer = null;
        this.cursor++;
        this.position = next.at;
        this.positionAt = dueAt;
        this.fire(next);
        this.scheduleNext();
      },
      Math.max(0, dueAt - now),
    );
  }

  private fire(e: TimelineEvent): void {
    if (e.kind === 'tick') {
      this.emit({ type: 'position', positionMs: e.at });
      return;
    }
    const base = {
      speaker: e.u.speaker,
      key: `u-${String(e.u.idx)}`,
      startMs: e.u.startedMs,
      endMs: e.u.endedMs,
    };
    if (e.kind === 'interim') {
      const text = e.u.text.split(/\s+/).slice(0, e.words).join(' ');
      this.emit({ type: 'interim', ...base, text });
    } else {
      this.emit({ type: 'final', ...base, text: e.u.text, confidence: null });
    }
  }

  private emit(e: SourceEvent): void {
    for (const l of this.listeners) l(e);
  }
}

/** Interims every 300 ms within each utterance, a final at its end, and position ticks. */
function buildTimeline(utterances: readonly TimedUtterance[], durationMs: number): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const u of utterances) {
    const words = u.text.split(/\s+/).filter(Boolean).length;
    const span = u.endedMs - u.startedMs;
    for (let t = u.startedMs; t < u.endedMs; t += INTERIM_STEP_MS) {
      // Words "heard so far" at time t (at least one, like real STT as speech starts).
      const shown = Math.max(1, Math.ceil(((t - u.startedMs) / Math.max(span, 1)) * words));
      if (shown >= words && t > u.startedMs) break; // the final will carry the full text
      events.push({ at: t, kind: 'interim', u, words: Math.min(shown, words) });
    }
    events.push({ at: u.endedMs, kind: 'final', u });
  }
  for (let t = TICK_MS; t < durationMs; t += TICK_MS) events.push({ at: t, kind: 'tick' });
  // Stable order: by time; at equal times finals first, then interims, then ticks.
  const rank = { final: 0, interim: 1, tick: 2 } as const;
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.at - b.e.at || rank[a.e.kind] - rank[b.e.kind] || a.i - b.i)
    .map(({ e }) => e);
}
