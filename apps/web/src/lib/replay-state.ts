import {
  CLOSE_CODE,
  type FeedbackSignal,
  type FinalUtterance,
  type ServerMessage,
  type SessionState,
  type Speaker,
  type Speed,
  type SuggestionFailureReason,
} from '@cue/shared';

/**
 * UI state of the replay player, derived only from protocol messages and
 * socket events. A pure reducer, so every state the user can see is testable
 * without a browser.
 */

export type ConnectionStatus =
  | 'connecting' // opening the socket / authenticating
  | 'open' // ready
  | 'reconnecting' // dropped; retrying with backoff
  | 'offline' // gave up retrying; user can press Reconnect
  | 'not_found'; // the session no longer exists (or isn't ours)

export interface InterimLine {
  key: string;
  speaker: Speaker;
  text: string;
  startMs: number;
}

export interface Banner {
  level: 'info' | 'warning' | 'error';
  message: string;
  /** What the banner's button does, if it has one. */
  action?: 'retry' | 'reconnect' | 'restart';
}

export interface SuggestionView {
  id: string;
  utteranceId: string;
  text: string;
  status: 'thinking' | 'streaming' | 'complete' | 'dropped';
  reason?: SuggestionFailureReason;
  /** Latency from the end of the prospect's line (server-measured). */
  firstTokenMs?: number;
  lastTokenMs?: number;
  /** lastTokenMs + time for this browser to paint it (excludes network transit). */
  renderedMs?: number;
  feedback: FeedbackSignal[];
}

export interface SuggestionsAvailability {
  available: boolean;
  model: string | null;
  playbook: string | null;
}

export const MAX_PAST_SUGGESTIONS = 5;

export interface ReplayState {
  connection: ConnectionStatus;
  /** Reconnect attempt number (1-based) while reconnecting. */
  attempt: number;
  sessionId: string | null;
  /** 'idle' = no replay started yet in this page. */
  playback: SessionState | 'idle';
  positionMs: number;
  speed: Speed;
  durationMs: number;
  finals: FinalUtterance[];
  interims: Record<string, InterimLine>;
  banner: Banner | null;
  suggestions: SuggestionsAvailability | null;
  /** The suggestion being shown (streaming, done, or just dropped). */
  suggestion: SuggestionView | null;
  /** Earlier suggestions, newest first. */
  pastSuggestions: SuggestionView[];
}

export type ReplayAction =
  | { type: 'server'; message: ServerMessage }
  | { type: 'connecting' }
  | { type: 'socket_closed'; code: number; attempt: number; willRetry: boolean }
  | { type: 'gave_up' }
  | { type: 'dismiss_banner' }
  | { type: 'suggestion_rendered'; suggestionId: string; renderDelayMs: number };

export function initialReplayState(durationMs: number): ReplayState {
  return {
    connection: 'connecting',
    attempt: 0,
    sessionId: null,
    playback: 'idle',
    positionMs: 0,
    speed: '1x',
    durationMs,
    finals: [],
    interims: {},
    banner: null,
    suggestions: null,
    suggestion: null,
    pastSuggestions: [],
  };
}

/** Apply `fn` to the suggestion with this id, whether current or past. */
function updateSuggestion(
  state: ReplayState,
  id: string,
  fn: (s: SuggestionView) => SuggestionView,
): ReplayState {
  if (state.suggestion?.id === id) return { ...state, suggestion: fn(state.suggestion) };
  if (!state.pastSuggestions.some((s) => s.id === id)) return state;
  return { ...state, pastSuggestions: state.pastSuggestions.map((s) => (s.id === id ? fn(s) : s)) };
}

/** Insert or replace by utteranceId, keeping timeline order. */
function upsertFinal(finals: FinalUtterance[], f: FinalUtterance): FinalUtterance[] {
  const rest = finals.filter((x) => x.utteranceId !== f.utteranceId);
  rest.push(f);
  return rest.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

function withoutInterim(interims: Record<string, InterimLine>, key: string) {
  if (!(key in interims)) return interims;
  return Object.fromEntries(Object.entries(interims).filter(([k]) => k !== key));
}

export function replayReducer(state: ReplayState, action: ReplayAction): ReplayState {
  switch (action.type) {
    case 'connecting':
      return {
        ...state,
        connection: state.connection === 'reconnecting' ? 'reconnecting' : 'connecting',
      };

    case 'socket_closed': {
      // Interims are stale once the socket is gone; finals stay.
      const base = { ...state, interims: {} };
      if (action.code === CLOSE_CODE.notFound) {
        return {
          ...base,
          connection: 'not_found',
          banner: {
            level: 'error',
            message: 'This replay is no longer available.',
            action: 'restart',
          },
        };
      }
      if (!action.willRetry) return base;
      return {
        ...base,
        connection: 'reconnecting',
        attempt: action.attempt,
        banner: {
          level: 'warning',
          message:
            action.code === CLOSE_CODE.serverShutdown
              ? `The server is restarting. Reconnecting (attempt ${String(action.attempt)})…`
              : action.code === CLOSE_CODE.clientTooSlow
                ? `Your connection couldn't keep up. Reconnecting (attempt ${String(action.attempt)})…`
                : `Connection lost. Reconnecting (attempt ${String(action.attempt)})…`,
        },
      };
    }

    case 'gave_up':
      return {
        ...state,
        connection: 'offline',
        interims: {},
        banner: { level: 'error', message: "Can't reach the replay server.", action: 'reconnect' },
      };

    case 'dismiss_banner':
      return { ...state, banner: null };

    case 'suggestion_rendered':
      return updateSuggestion(state, action.suggestionId, (s) =>
        s.lastTokenMs === undefined
          ? s
          : { ...s, renderedMs: s.lastTokenMs + action.renderDelayMs },
      );

    case 'server':
      return onServerMessage(state, action.message);
  }
}

function onServerMessage(state: ReplayState, m: ServerMessage): ReplayState {
  switch (m.type) {
    case 'ready':
      return {
        ...state,
        connection: 'open',
        attempt: 0,
        // A reconnect banner is resolved once we're back.
        banner: state.banner?.level === 'warning' ? null : state.banner,
      };

    case 'session':
      if (m.sessionId === state.sessionId) {
        return { ...state, durationMs: m.durationMs, suggestions: m.suggestions };
      }
      // A different session (new replay, or a backward seek): start a fresh transcript.
      return {
        ...state,
        sessionId: m.sessionId,
        durationMs: m.durationMs,
        suggestions: m.suggestions,
        suggestion: null,
        pastSuggestions: [],
        finals: [],
        interims: {},
        banner: state.banner?.action === 'restart' ? null : state.banner,
      };

    case 'snapshot':
      return {
        ...state,
        finals: [...m.utterances].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs),
        interims: {},
      };

    case 'state':
      return {
        ...state,
        playback: m.state,
        positionMs: m.positionMs,
        speed: m.speed,
        interims: m.state === 'playing' ? state.interims : {},
        banner:
          m.state === 'failed'
            ? { level: 'error', message: 'This replay failed.', action: 'restart' }
            : state.banner,
      };

    case 'interim':
      return {
        ...state,
        interims: {
          ...state.interims,
          [m.key]: { key: m.key, speaker: m.speaker, text: m.text, startMs: m.startMs },
        },
      };

    case 'final': {
      const final: FinalUtterance = {
        utteranceId: m.utteranceId,
        speaker: m.speaker,
        key: m.key,
        text: m.text,
        startMs: m.startMs,
        endMs: m.endMs,
      };
      return {
        ...state,
        finals: upsertFinal(state.finals, final),
        interims: withoutInterim(state.interims, m.key),
      };
    }

    case 'status':
      if (m.code === 'persist_failed') {
        return { ...state, banner: { level: 'error', message: m.message, action: 'retry' } };
      }
      return { ...state, banner: { level: m.level, message: m.message } };

    case 'error':
      return {
        ...state,
        banner: {
          level: m.code === 'bad_request' ? 'warning' : 'error',
          message: m.message,
          ...(m.code === 'invalid_state' || m.code === 'not_found'
            ? { action: 'restart' as const }
            : {}),
        },
      };

    case 'pong':
      return state;

    case 'suggestionStarted': {
      // The previous one (if any) moves to the history.
      const past = state.suggestion
        ? [state.suggestion, ...state.pastSuggestions].slice(0, MAX_PAST_SUGGESTIONS)
        : state.pastSuggestions;
      return {
        ...state,
        pastSuggestions: past,
        suggestion: {
          id: m.suggestionId,
          utteranceId: m.utteranceId,
          text: '',
          status: 'thinking',
          feedback: [],
        },
      };
    }

    case 'suggestionToken':
      return updateSuggestion(state, m.suggestionId, (s) =>
        s.status === 'thinking' || s.status === 'streaming'
          ? { ...s, text: m.text, status: 'streaming' }
          : s,
      );

    case 'suggestionCompleted':
      return updateSuggestion(state, m.suggestionId, (s) => ({
        ...s,
        text: m.text,
        status: 'complete',
        firstTokenMs: m.firstTokenMs,
        lastTokenMs: m.lastTokenMs,
      }));

    case 'suggestionDropped':
      return updateSuggestion(state, m.suggestionId, (s) => ({
        ...s,
        status: 'dropped',
        reason: m.reason,
      }));

    case 'feedbackSaved':
      return updateSuggestion(state, m.suggestionId, (s) => ({ ...s, feedback: m.signals }));
  }
}

// ------------------------------------------------------------------ reconnect

export const MAX_RECONNECT_ATTEMPTS = 8;

/**
 * Delay before reconnect attempt `attempt` (1-based): 0.5 s doubling up to
 * 10 s, with jitter (50–100 %) so many clients don't reconnect in lockstep
 * after a server restart.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(10_000, 500 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.5 + random() * 0.5));
}

/** Whether a close code means "try again" (vs. a final answer). */
export function shouldReconnect(code: number): boolean {
  // 1000 = we closed it on purpose; 4404 = session gone (a final answer).
  // 4401 (bad/expired/reused ticket) IS retried: each attempt fetches a fresh ticket,
  // and if the user is really signed out, fetching the ticket redirects to /signin.
  return code !== 1000 && code !== CLOSE_CODE.notFound;
}
