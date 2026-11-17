import {
  appendSessionUtterance,
  createReplaySession,
  type Db,
  endIdleSessions,
  endSession,
  getRecording,
  getRecordingUtterances,
  getSession,
  listSessionUtterances,
  type SessionUtterance,
  updateSessionPosition,
} from '@cue/db';
import type { Speed } from '@cue/shared';
import type { Clock, TimerHandle } from '../clock';
import { TranscriptSource } from '../sources/transcript-source';
import { ReplaySession, type SessionStore, utteranceSignature } from './replay-session';

export const IDLE_SESSION_MS = 60 * 60 * 1000;
const IDLE_SWEEP_EVERY_MS = 5 * 60 * 1000;

export type StartResult =
  { ok: true; session: ReplaySession } | { ok: false; error: 'not_found' | 'empty_recording' };

export type ResumeResult =
  | { ok: true; session: ReplaySession; saved: SessionUtterance[] }
  | { ok: false; error: 'not_found' | 'not_live' | 'recording_missing' };

interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * Creates, resumes and restarts replay sessions, and runs the idle cleanup.
 * Every database call is scoped to the owning user (store below), so one user
 * can never touch another's session.
 */
export class SessionManager {
  private readonly active = new Map<string, { session: ReplaySession; userId: string }>();
  private sweepTimer: TimerHandle | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  private storeFor(userId: string, callId: string): SessionStore {
    return {
      append: (u) => appendSessionUtterance(this.db, userId, callId, u),
      savePosition: (ms) => updateSessionPosition(this.db, userId, callId, ms),
      end: (status, ms) => endSession(this.db, userId, callId, status, ms),
    };
  }

  private async build(
    userId: string,
    callId: string,
    recordingId: string,
    savedSignatures: string[],
  ): Promise<ReplaySession | null> {
    const [recording, utterances] = await Promise.all([
      getRecording(this.db, recordingId),
      getRecordingUtterances(this.db, recordingId),
    ]);
    if (!recording || utterances.length === 0) return null;
    const source = new TranscriptSource(utterances, this.clock);
    const session = new ReplaySession(
      {
        sessionId: callId,
        recordingId,
        title: recording.title,
        durationMs: source.durationMs,
        timing: recording.timing,
      },
      source,
      this.storeFor(userId, callId),
      this.clock,
      {
        savedSignatures,
        onFinished: (s) => {
          this.active.delete(s.id);
        },
      },
    );
    this.active.set(callId, { session, userId });
    return session;
  }

  /** New replay of a recording (a new `calls` row owned by the user). */
  async start(userId: string, recordingId: string, speed: Speed, fromMs = 0): Promise<StartResult> {
    const recording = await getRecording(this.db, recordingId);
    if (!recording) return { ok: false, error: 'not_found' };
    const call = await createReplaySession(this.db, userId, recordingId, fromMs);
    if (!call) return { ok: false, error: 'not_found' };
    const session = await this.build(userId, call.id, recordingId, []);
    if (!session) {
      await endSession(this.db, userId, call.id, 'failed', fromMs);
      return { ok: false, error: 'empty_recording' };
    }
    session.begin(fromMs, speed, false);
    this.log.info({ sessionId: call.id, recordingId, userId }, 'replay started');
    return { ok: true, session };
  }

  /**
   * Continue a live session after a reconnect or a server restart. Starts
   * paused at the saved position; already-saved finals are never re-saved.
   */
  async resume(userId: string, sessionId: string): Promise<ResumeResult> {
    const call = await getSession(this.db, userId, sessionId);
    if (!call) return { ok: false, error: 'not_found' }; // missing OR not theirs: same answer
    if (call.status !== 'live') return { ok: false, error: 'not_live' };
    const saved = await listSessionUtterances(this.db, userId, sessionId);

    const existing = this.active.get(sessionId);
    if (existing?.userId === userId) return { ok: true, session: existing.session, saved };

    if (!call.recordingId) return { ok: false, error: 'recording_missing' };
    const session = await this.build(
      userId,
      sessionId,
      call.recordingId,
      saved.map((u) =>
        utteranceSignature({
          speaker: u.speaker,
          startMs: u.startedMs,
          endMs: u.endedMs,
          text: u.text,
        }),
      ),
    );
    if (!session) return { ok: false, error: 'recording_missing' };
    session.begin(call.positionMs, '1x', true);
    this.log.info({ sessionId, userId, positionMs: call.positionMs }, 'replay resumed');
    return { ok: true, session, saved };
  }

  /**
   * Backward seek: utterances are append-only, so end this session and start
   * a new one at the earlier position. The old session keeps everything it saved.
   */
  async restartFrom(
    old: ReplaySession,
    userId: string,
    toMs: number,
    speed: Speed,
  ): Promise<StartResult> {
    await old.finish('ended', { silent: true });
    return this.start(userId, old.info.recordingId, speed, toMs);
  }

  /** End abandoned sessions (live, no activity for an hour). Runs now and every 5 minutes. */
  startIdleCleanup(): void {
    const sweep = async () => {
      try {
        const n = await endIdleSessions(this.db, IDLE_SESSION_MS);
        if (n > 0) this.log.info({ ended: n }, 'ended idle sessions');
      } catch (err) {
        this.log.error({ err }, 'idle session cleanup failed');
      }
      this.sweepTimer = this.clock.setTimeout(() => void sweep(), IDLE_SWEEP_EVERY_MS);
    };
    void sweep();
  }

  /**
   * Graceful shutdown: pause every session, finish saving, and record its
   * position. Sessions stay LIVE so clients can resume after the restart.
   */
  async shutdown(): Promise<void> {
    if (this.sweepTimer) this.clock.clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
    const sessions = [...this.active.values()];
    this.active.clear();
    await Promise.all(sessions.map(({ session }) => session.suspend()));
    this.log.info({ suspended: sessions.length }, 'sessions suspended for shutdown');
  }
}
