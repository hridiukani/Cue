import {
  appendSessionUtterance,
  createReplaySession,
  createSuggestion,
  type Db,
  endIdleSessions,
  endSession,
  finishSuggestion,
  getPlaybook,
  getRecording,
  getRecordingUtterances,
  getSession,
  listSessionUtterances,
  type SessionUtterance,
  setSuggestionRendered,
  updateSessionPosition,
} from '@cue/db';
import type { Speed } from '@cue/shared';
import type { Clock, TimerHandle } from '../clock';
import { TranscriptSource } from '../sources/transcript-source';
import {
  DEFAULT_SUGGESTION_CONFIG,
  type SuggestionConfig,
  SuggestionEngine,
  type SuggestionStore,
} from '../suggestions/engine';
import { repSpeechCanCancel } from '../suggestions/backchannel';
import type { LlmClient, PlaybookForPrompt } from '@cue/suggest';
import { ReplaySession, type SessionStore, utteranceSignature } from './replay-session';

export const IDLE_SESSION_MS = 60 * 60 * 1000;
const IDLE_SWEEP_EVERY_MS = 5 * 60 * 1000;

export type StartResult =
  | { ok: true; session: ReplaySession }
  | { ok: false; error: 'not_found' | 'empty_recording' | 'playbook_not_found' };

export type ResumeResult =
  | { ok: true; session: ReplaySession; saved: SessionUtterance[] }
  | { ok: false; error: 'not_found' | 'not_live' | 'recording_missing' };

interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface SuggestionDeps {
  /** null = suggestions disabled (no API key); sessions tell the browser so. */
  llm: LlmClient | null;
  config: Pick<SuggestionConfig, 'model' | 'firstTokenTimeoutMs' | 'totalTimeoutMs'>;
}

/**
 * Creates, resumes and restarts replay sessions, and runs the idle cleanup.
 * Every database call is scoped to the owning user (stores below), so one
 * user can never touch another's session or suggestions.
 */
export class SessionManager {
  private readonly active = new Map<string, { session: ReplaySession; userId: string }>();
  private sweepTimer: TimerHandle | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly suggestions: SuggestionDeps = {
      llm: null,
      config: { model: 'none', firstTokenTimeoutMs: 1500, totalTimeoutMs: 5000 },
    },
  ) {}

  private storeFor(userId: string, callId: string): SessionStore {
    return {
      append: (u) => appendSessionUtterance(this.db, userId, callId, u),
      savePosition: (ms) => updateSessionPosition(this.db, userId, callId, ms),
      end: (status, ms) => endSession(this.db, userId, callId, status, ms),
    };
  }

  private suggestionStoreFor(userId: string, callId: string): SuggestionStore {
    return {
      create: (s) => createSuggestion(this.db, userId, { ...s, callId }),
      finish: (id, outcome) => finishSuggestion(this.db, userId, id, outcome),
      rendered: (id, at) => setSuggestionRendered(this.db, userId, id, at),
    };
  }

  private async build(
    userId: string,
    callId: string,
    recordingId: string,
    playbookId: string | null,
    saved: SessionUtterance[],
  ): Promise<ReplaySession | null> {
    const [recording, utterances, playbookRow] = await Promise.all([
      getRecording(this.db, recordingId),
      getRecordingUtterances(this.db, recordingId),
      playbookId ? getPlaybook(this.db, userId, playbookId) : Promise.resolve(null),
    ]);
    if (!recording || utterances.length === 0) return null;
    const playbook: PlaybookForPrompt | null = playbookRow
      ? {
          name: playbookRow.name,
          productDescription: playbookRow.productDescription,
          idealCustomer: playbookRow.idealCustomer,
          objections: playbookRow.objections,
          toneNotes: playbookRow.toneNotes,
        }
      : null;

    const source = new TranscriptSource(utterances, this.clock);
    const { llm, config } = this.suggestions;
    const session = new ReplaySession(
      {
        sessionId: callId,
        recordingId,
        playbookId: playbookRow?.id ?? null,
        title: recording.title,
        durationMs: source.durationMs,
        timing: recording.timing,
      },
      source,
      this.storeFor(userId, callId),
      this.clock,
      {
        savedSignatures: saved.map((u) =>
          utteranceSignature({
            speaker: u.speaker,
            startMs: u.startedMs,
            endMs: u.endedMs,
            text: u.text,
          }),
        ),
        history: saved.map((u) => ({ speaker: u.speaker, text: u.text })),
        onFinished: (s) => {
          this.active.delete(s.id);
        },
        ...(llm
          ? {
              suggestions: {
                info: { available: true, model: config.model, playbook: playbook?.name ?? null },
                create: (send) =>
                  new SuggestionEngine({
                    llm,
                    clock: this.clock,
                    store: this.suggestionStoreFor(userId, callId),
                    send,
                    config: { ...DEFAULT_SUGGESTION_CONFIG, ...config },
                    playbook,
                    // Rep timing in estimated recordings is invented: it never cancels.
                    cancelOnRepSpeech: repSpeechCanCancel(recording.timing),
                    log: this.log,
                  }),
              },
            }
          : {}),
      },
    );
    this.active.set(callId, { session, userId });
    return session;
  }

  /** New replay of a recording (a new `calls` row owned by the user). */
  async start(
    userId: string,
    recordingId: string,
    speed: Speed,
    fromMs = 0,
    playbookId: string | null = null,
  ): Promise<StartResult> {
    const recording = await getRecording(this.db, recordingId);
    if (!recording) return { ok: false, error: 'not_found' };
    const call = await createReplaySession(this.db, userId, recordingId, fromMs, playbookId);
    // The recording exists, so a null here means the playbook isn't the user's.
    if (!call) return { ok: false, error: 'playbook_not_found' };
    const session = await this.build(userId, call.id, recordingId, call.playbookId, []);
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
    const session = await this.build(userId, sessionId, call.recordingId, call.playbookId, saved);
    if (!session) return { ok: false, error: 'recording_missing' };
    session.begin(call.positionMs, '1x', true);
    this.log.info({ sessionId, userId, positionMs: call.positionMs }, 'replay resumed');
    return { ok: true, session, saved };
  }

  /**
   * Backward seek: utterances are append-only, so end this session and start
   * a new one at the earlier position, with the same playbook. The old
   * session keeps everything it saved.
   */
  async restartFrom(
    old: ReplaySession,
    userId: string,
    toMs: number,
    speed: Speed,
  ): Promise<StartResult> {
    await old.finish('ended', { silent: true });
    return this.start(userId, old.info.recordingId, speed, toMs, old.info.playbookId);
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
