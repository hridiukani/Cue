import type { ServerMessageBody, SessionState, Speed } from '@cue/shared';
import type { Clock, TimerHandle } from '../clock';
import type { CallSource, SourceEvent } from '../sources/call-source';
import { BACKPRESSURE, shouldSend, slowClientAction } from './backpressure';

/** Where a session's messages go: one browser socket (or nothing while disconnected). */
export interface Sink {
  send(body: ServerMessageBody): void;
  bufferedBytes(): number;
  close(code: number, reason: string): void;
}

/** Persistence for one session, already scoped to its owner (see SessionManager). */
export interface SessionStore {
  append(u: {
    speaker: 'rep' | 'prospect';
    text: string;
    startedMs: number;
    endedMs: number;
    confidence: number | null;
  }): Promise<{ id: string } | null>;
  savePosition(positionMs: number): Promise<boolean>;
  end(status: 'ended' | 'failed', positionMs: number): Promise<boolean>;
}

export interface SessionInfo {
  sessionId: string;
  recordingId: string;
  title: string;
  durationMs: number;
  timing: 'real' | 'estimated';
}

type FinalEvent = Extract<SourceEvent, { type: 'final' }>;
type PauseReason =
  'user' | 'client_slow' | 'persist_failed' | 'db_backlog' | 'disconnected' | 'shutdown';

const MAX_QUEUE = 50;
const RESUME_QUEUE = 10;
const SAVE_POSITION_EVERY_MS = 5000;
const PERSIST_RETRY_DELAY_MS = 200;

/** Identity of an utterance on the timeline, used to never save the same final twice. */
export function utteranceSignature(u: {
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
}): string {
  return `${u.speaker}|${String(u.startMs)}|${String(u.endMs)}|${u.text}`;
}

/**
 * One replay session. Owns the source, the save queue and backpressure.
 *
 * Rules:
 * - SAVE BEFORE SEND: a final is sent to the browser only after it's saved.
 *   Utterances are append-only; a final already saved (by signature) is never
 *   saved again, which makes resume after a crash duplicate-free.
 * - The session never ends just because the socket dropped or the server is
 *   shutting down: it pauses and saves its position, so it can resume.
 */
export class ReplaySession {
  private sink: Sink | null = null;
  private readonly pauseReasons = new Set<PauseReason>();
  private readonly saved = new Set<string>();
  private readonly queue: FinalEvent[] = [];
  private draining: Promise<void> | null = null;
  private sourceEnded = false;
  private terminal: 'ended' | 'failed' | null = null;
  private lastPositionSaveAt = 0;
  private slowSince: number | null = null;
  private slowTimer: TimerHandle | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    readonly info: SessionInfo,
    private readonly source: CallSource,
    private readonly store: SessionStore,
    private readonly clock: Clock,
    opts: { savedSignatures?: Iterable<string>; onFinished?: (s: ReplaySession) => void } = {},
  ) {
    for (const s of opts.savedSignatures ?? []) this.saved.add(s);
    this.onFinished = opts.onFinished;
    this.unsubscribe = source.on((e) => {
      this.onSourceEvent(e);
    });
  }

  private readonly onFinished: ((s: ReplaySession) => void) | undefined;

  get id(): string {
    return this.info.sessionId;
  }
  get positionMs(): number {
    return this.source.positionMs;
  }
  get state(): SessionState {
    if (this.terminal) return this.terminal;
    return this.source.playing ? 'playing' : 'paused';
  }
  /** What the browser is told about suggestions for this session (wired to the engine later). */
  get suggestionsInfo(): { available: boolean; model: string | null; playbook: string | null } {
    return { available: false, model: null, playbook: null };
  }

  get capabilities() {
    return { seek: this.source.capabilities.seek, speeds: [...this.source.capabilities.speeds] };
  }

  /** Begin playback at `fromMs`. `paused` starts it paused (used for resume). */
  begin(fromMs: number, speed: Speed, paused: boolean): void {
    if (paused) this.pauseReasons.add('user');
    this.source.start(fromMs, speed);
    if (paused) this.source.pause();
  }

  attach(sink: Sink): void {
    this.sink = sink;
    this.pauseReasons.delete('disconnected');
  }

  /** Socket gone: pause and save where we are. The session stays live. */
  async detach(): Promise<void> {
    this.sink = null;
    this.stopSlowTimer();
    this.pauseFor('disconnected');
    await this.settle();
    await this.savePosition(true);
  }

  play(): void {
    if (this.terminal) return;
    this.pauseReasons.delete('user');
    if (this.pauseReasons.delete('persist_failed')) void this.drain(); // "Retry"
    this.maybeResume();
    this.sendState();
  }

  pause(): void {
    this.pauseFor('user');
    void this.savePosition(true);
  }

  /** Forward seeks stay in this session (backward seeks start a new one: SessionManager). */
  seekForward(toMs: number): void {
    if (this.terminal) return;
    this.source.seek(toMs);
    this.sendState();
    void this.savePosition(true);
  }

  setSpeed(speed: Speed): void {
    if (this.terminal) return;
    this.source.setSpeed(speed);
    this.sendState();
  }

  /** Server shutdown: stop, finish saving, keep the session live for resume. */
  async suspend(): Promise<void> {
    this.pauseFor('shutdown');
    await this.settle();
    await this.savePosition(true);
    this.stopSlowTimer();
    this.unsubscribe();
    await this.source.close();
  }

  /** End for good (reached the end, failed, or replaced by a backward seek). */
  async finish(status: 'ended' | 'failed', opts: { silent?: boolean } = {}): Promise<void> {
    if (this.terminal) return;
    // Silent = being replaced by a new session (backward seek): the browser
    // gets the new session's messages instead of a confusing "ended".
    if (opts.silent) this.sink = null;
    this.source.pause();
    await this.settle();
    this.terminal = status;
    this.stopSlowTimer();
    this.unsubscribe();
    await this.source.close();
    await this.store.end(status, this.source.positionMs);
    this.sendState();
    this.onFinished?.(this);
  }

  sendState(): void {
    this.sink?.send({
      type: 'state',
      state: this.state,
      positionMs: Math.round(this.source.positionMs),
      speed: this.source.speed,
    });
  }

  // ------------------------------------------------------------------ internals

  private onSourceEvent(e: SourceEvent): void {
    switch (e.type) {
      case 'interim': {
        const sink = this.sink;
        if (sink && shouldSend('interim', sink.bufferedBytes())) {
          sink.send({
            type: 'interim',
            speaker: e.speaker,
            key: e.key,
            text: e.text,
            startMs: e.startMs,
            endMs: e.endMs,
          });
        }
        this.checkSlowClient();
        return;
      }
      case 'final': {
        if (this.saved.has(utteranceSignature(e))) return; // already saved before a resume
        this.queue.push(e);
        if (this.queue.length > MAX_QUEUE) this.pauseFor('db_backlog');
        void this.drain();
        return;
      }
      case 'position': {
        this.sendState();
        void this.savePosition(false);
        this.checkSlowClient();
        return;
      }
      case 'ended': {
        this.sourceEnded = true;
        void this.drain();
        return;
      }
      case 'error': {
        this.sink?.send({
          type: 'status',
          level: 'error',
          code: 'source_error',
          message: e.message,
          retryable: false,
        });
        void this.finish('failed');
        return;
      }
    }
  }

  /** Save queued finals one at a time, then send each. Single-flight. */
  private drain(): Promise<void> {
    this.draining ??= (async () => {
      try {
        while (this.queue.length > 0 && !this.pauseReasons.has('persist_failed')) {
          const head = this.queue[0];
          if (!head) break;
          const saved = await this.persistWithRetry(head);
          if (!saved) {
            this.pauseFor('persist_failed');
            this.sink?.send({
              type: 'status',
              level: 'error',
              code: 'persist_failed',
              message: 'Could not save the transcript. Playback is paused; press play to retry.',
              retryable: true,
            });
            break;
          }
          this.queue.shift();
          this.saved.add(utteranceSignature(head));
          this.sink?.send({
            type: 'final',
            utteranceId: saved.id,
            speaker: head.speaker,
            key: head.key,
            text: head.text,
            startMs: head.startMs,
            endMs: head.endMs,
          });
          await this.store.savePosition(this.safePosition());
          this.lastPositionSaveAt = this.clock.now();
          if (this.queue.length <= RESUME_QUEUE && this.pauseReasons.delete('db_backlog')) {
            this.maybeResume();
          }
        }
      } finally {
        this.draining = null;
      }
      if (this.sourceEnded && this.queue.length === 0 && !this.terminal) await this.finish('ended');
    })();
    return this.draining;
  }

  private async persistWithRetry(e: FinalEvent): Promise<{ id: string } | null> {
    const row = {
      speaker: e.speaker,
      text: e.text,
      startedMs: e.startMs,
      endedMs: e.endMs,
      confidence: e.confidence,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const saved = await this.store.append(row);
        if (saved) return saved;
        return null; // session no longer live or not ours: retrying won't help
      } catch {
        if (attempt === 0)
          await new Promise<void>((r) => this.clock.setTimeout(r, PERSIST_RETRY_DELAY_MS));
      }
    }
    return null;
  }

  /** Wait for in-flight saves to finish. */
  private async settle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async savePosition(force: boolean): Promise<void> {
    if (this.terminal) return;
    const now = this.clock.now();
    if (!force && now - this.lastPositionSaveAt < SAVE_POSITION_EVERY_MS) return;
    this.lastPositionSaveAt = now;
    try {
      await this.store.savePosition(this.safePosition());
    } catch {
      // Best effort; the next save or the next final will try again.
    }
  }

  /**
   * The position it's safe to resume from. Never past a final that isn't saved
   * yet: at instant speed the source runs ahead of the save queue, and resuming
   * past an unsaved final would lose it. (Resume is inclusive and skips finals
   * already saved, so saving an earlier position never duplicates anything.)
   */
  private safePosition(): number {
    const firstUnsaved = this.queue[0];
    const pos = this.source.positionMs;
    return firstUnsaved ? Math.min(pos, firstUnsaved.endMs) : pos;
  }

  private pauseFor(reason: PauseReason): void {
    const wasPlaying = this.source.playing;
    this.pauseReasons.add(reason);
    this.source.pause();
    if (wasPlaying) this.sendState();
  }

  private maybeResume(): void {
    if (this.terminal || this.sourceEnded || this.pauseReasons.size > 0) return;
    this.source.resume();
  }

  private checkSlowClient(): void {
    const sink = this.sink;
    if (!sink) return;
    const now = this.clock.now();
    const action = slowClientAction(
      sink.bufferedBytes(),
      this.pauseReasons.has('client_slow'),
      this.slowSince,
      now,
    );
    if (action === 'pause' && !this.pauseReasons.has('client_slow')) {
      this.slowSince = now;
      this.pauseFor('client_slow');
      sink.send({
        type: 'status',
        level: 'warning',
        code: 'client_slow',
        message: 'Your connection is falling behind; playback paused until it catches up.',
        retryable: false,
      });
      this.slowTimer = this.clock.setTimeout(() => {
        this.slowTimer = null;
        this.checkSlowClient();
      }, BACKPRESSURE.pollMs);
    } else if (action === 'pause') {
      this.slowTimer = this.clock.setTimeout(() => {
        this.slowTimer = null;
        this.checkSlowClient();
      }, BACKPRESSURE.pollMs);
    } else if (action === 'recovered') {
      this.slowSince = null;
      this.pauseReasons.delete('client_slow');
      this.maybeResume();
      this.sendState();
    } else if (action === 'close') {
      this.stopSlowTimer();
      sink.close(4429, 'client too slow');
    }
  }

  private stopSlowTimer(): void {
    if (this.slowTimer) this.clock.clearTimeout(this.slowTimer);
    this.slowTimer = null;
  }
}
